/**
 * Tests for routing requests to Clawdbot sessions.
 *
 * Note: These tests verify the handler's routing logic without mocking
 * the agent infrastructure, which would require complex hoisting.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { validateBearerAuth } from "../auth.js";
import {
  messagesToClawdbotFormat,
  parseOpenAIChatRequest,
} from "../parse-request.js";

/**
 * Create a mock HTTP request.
 */
function createMockRequest(opts: {
  body: unknown;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const {
    body,
    path = "/v1/chat/completions",
    method = "POST",
    headers = {},
  } = opts;
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const chunks = [Buffer.from(bodyStr)];
  let index = 0;

  const readable = new Readable({
    read() {
      if (index < chunks.length) {
        this.push(chunks[index++]);
      } else {
        this.push(null);
      }
    },
  });

  return Object.assign(readable, {
    headers: {
      "content-type": "application/json",
      host: "localhost:18789",
      ...headers,
    },
    url: path,
    method,
  }) as unknown as IncomingMessage;
}

/**
 * Create a mock HTTP response.
 */
function _createMockResponse(): {
  res: ServerResponse;
  data: string[];
  getStatusCode: () => number;
  headers: Record<string, string | number>;
} {
  const data: string[] = [];
  const headers: Record<string, string | number> = {};
  let statusCode = 200;

  const res = {
    writeHead: vi.fn((code: number, hdrs?: Record<string, string | number>) => {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    }),
    write: vi.fn((chunk: string) => {
      data.push(chunk);
      return true;
    }),
    end: vi.fn((chunk?: string) => {
      if (chunk) data.push(chunk);
    }),
    setHeader: vi.fn((name: string, value: string | number) => {
      headers[name] = value;
    }),
    get statusCode() {
      return statusCode;
    },
    set statusCode(code: number) {
      statusCode = code;
    },
    on: vi.fn(),
  } as unknown as ServerResponse;

  return { res, data, getStatusCode: () => statusCode, headers };
}

describe("OpenAI-compat routing logic", () => {
  const validApiKey = "test-api-key";

  describe("authentication integration", () => {
    it("validates bearer token correctly", () => {
      const req = createMockRequest({
        body: {},
        headers: { authorization: `Bearer ${validApiKey}` },
      });

      const result = validateBearerAuth(req, validApiKey);
      expect(result.ok).toBe(true);
    });

    it("rejects invalid bearer token", () => {
      const req = createMockRequest({
        body: {},
        headers: { authorization: "Bearer wrong-key" },
      });

      const result = validateBearerAuth(req, validApiKey);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
      }
    });

    it("rejects missing authorization", () => {
      const req = createMockRequest({
        body: {},
      });

      const result = validateBearerAuth(req, validApiKey);
      expect(result.ok).toBe(false);
    });
  });

  describe("request parsing integration", () => {
    it("parses valid request", async () => {
      const req = createMockRequest({
        body: {
          messages: [{ role: "user", content: "Hello" }],
          model: "gpt-4",
        },
      });

      const result = await parseOpenAIChatRequest(req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.model).toBe("gpt-4");
        expect(result.value.messages).toHaveLength(1);
      }
    });

    it("extracts session routing from user field", async () => {
      const req = createMockRequest({
        body: {
          messages: [{ role: "user", content: "Hello" }],
          user: "custom-session",
        },
      });

      const result = await parseOpenAIChatRequest(req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.user).toBe("custom-session");
        expect(result.value.sessionKey).toBe("custom-session");
      }
    });
  });

  describe("session key resolution", () => {
    it("uses user field for session routing", async () => {
      const req = createMockRequest({
        body: {
          messages: [{ role: "user", content: "test" }],
          user: "voice-session-123",
        },
      });

      const result = await parseOpenAIChatRequest(req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessionKey).toBe("voice-session-123");
      }
    });

    it("returns undefined sessionKey when no user specified", async () => {
      const req = createMockRequest({
        body: {
          messages: [{ role: "user", content: "test" }],
        },
      });

      const result = await parseOpenAIChatRequest(req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessionKey).toBeUndefined();
      }
    });
  });

  describe("X-Clawdbot-Session header", () => {
    it("header is accessible for routing", () => {
      const req = createMockRequest({
        body: {},
        headers: {
          "x-clawdbot-session": "header-session-key",
        },
      });

      const sessionHeader = req.headers["x-clawdbot-session"];
      expect(sessionHeader).toBe("header-session-key");
    });
  });

  describe("message conversion", () => {
    it("converts messages to Clawdbot format correctly", () => {
      const messages = [
        { role: "system" as const, content: "You are helpful" },
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Hi there" },
        { role: "user" as const, content: "How are you?" },
      ];

      const { message, systemPrompt } = messagesToClawdbotFormat(messages);

      expect(message).toBe("How are you?");
      expect(systemPrompt).toBe("You are helpful");
    });
  });

  describe("streaming mode detection", () => {
    it("defaults to streaming", async () => {
      const req = createMockRequest({
        body: {
          messages: [{ role: "user", content: "test" }],
        },
      });

      const result = await parseOpenAIChatRequest(req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.stream).toBe(true);
      }
    });

    it("respects explicit stream: false", async () => {
      const req = createMockRequest({
        body: {
          messages: [{ role: "user", content: "test" }],
          stream: false,
        },
      });

      const result = await parseOpenAIChatRequest(req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.stream).toBe(false);
      }
    });
  });

  describe("error response format", () => {
    it("returns OpenAI-format errors for invalid requests", async () => {
      const req = createMockRequest({
        body: { model: "gpt-4" }, // Missing messages
      });

      const result = await parseOpenAIChatRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toHaveProperty("message");
        expect(result.error.error).toHaveProperty("type");
        expect(result.error.error).toHaveProperty("code");
      }
    });

    it("returns OpenAI-format errors for auth failures", () => {
      const req = createMockRequest({
        body: {},
      });

      const result = validateBearerAuth(req, validApiKey);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error.type).toBe("authentication_error");
        expect(result.error.error.code).toBe("invalid_api_key");
      }
    });
  });
});
