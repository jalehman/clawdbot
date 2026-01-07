/**
 * Tests for OpenAI chat completion request parsing.
 */

import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  messagesToClawdbotFormat,
  parseOpenAIChatRequest,
} from "../parse-request.js";

/**
 * Create a mock HTTP request with a JSON body.
 */
function createMockRequest(
  body: unknown,
  contentType = "application/json",
): IncomingMessage {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const chunks = [Buffer.from(bodyStr)];
  let index = 0;

  const readable = new Readable({
    read() {
      if (index < chunks.length) {
        this.push(chunks[index++]);
      } else {
        this.push(null); // End the stream
      }
    },
  });

  return Object.assign(readable, {
    headers: {
      "content-type": contentType,
    },
    url: "/v1/chat/completions",
    method: "POST",
  }) as unknown as IncomingMessage;
}

describe("parseOpenAIChatRequest", () => {
  describe("content type validation", () => {
    it("rejects request without application/json content type", async () => {
      const req = createMockRequest({ messages: [] }, "text/plain");
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(415);
        expect(result.error.error.message).toContain("Content-Type");
      }
    });

    it("accepts application/json with charset", async () => {
      const req = createMockRequest(
        { messages: [{ role: "user", content: "hello" }] },
        "application/json; charset=utf-8",
      );
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(true);
    });
  });

  describe("body parsing", () => {
    it("rejects empty body", async () => {
      const req = createMockRequest("");
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error.error.message).toContain("empty");
      }
    });

    it("rejects invalid JSON", async () => {
      const req = createMockRequest("{ invalid json }");
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error.error.message).toContain("Invalid JSON");
      }
    });

    it("rejects non-object body", async () => {
      const req = createMockRequest('"string"');
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
      }
    });
  });

  describe("messages validation", () => {
    it("requires messages array", async () => {
      const req = createMockRequest({ model: "gpt-4" });
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error.error.message).toContain("messages");
      }
    });

    it("rejects empty messages array", async () => {
      const req = createMockRequest({ messages: [] });
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error.error.message).toContain("empty");
      }
    });

    it("rejects non-object message", async () => {
      const req = createMockRequest({ messages: ["hello"] });
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error.error.message).toContain("messages[0]");
      }
    });

    it("rejects invalid role", async () => {
      const req = createMockRequest({
        messages: [{ role: "invalid", content: "hello" }],
      });
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error.error.message).toContain("role");
      }
    });

    it("rejects non-string content", async () => {
      const req = createMockRequest({
        messages: [{ role: "user", content: 123 }],
      });
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error.error.message).toContain("content");
      }
    });

    it("accepts valid message roles", async () => {
      const req = createMockRequest({
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there" },
          { role: "user", content: "Goodbye" },
        ],
      });
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.messages).toHaveLength(4);
      }
    });
  });

  describe("optional fields", () => {
    it("uses default model when not specified", async () => {
      const req = createMockRequest({
        messages: [{ role: "user", content: "hello" }],
      });
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.model).toBe("clawdbot");
      }
    });

    it("uses specified model", async () => {
      const req = createMockRequest({
        model: "gpt-4-turbo",
        messages: [{ role: "user", content: "hello" }],
      });
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.model).toBe("gpt-4-turbo");
      }
    });

    it("defaults to streaming when stream not specified", async () => {
      const req = createMockRequest({
        messages: [{ role: "user", content: "hello" }],
      });
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.stream).toBe(true);
      }
    });

    it("respects stream: false", async () => {
      const req = createMockRequest({
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.stream).toBe(false);
      }
    });

    it("extracts user field for session routing", async () => {
      const req = createMockRequest({
        messages: [{ role: "user", content: "hello" }],
        user: "voice-session-123",
      });
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.user).toBe("voice-session-123");
        expect(result.value.sessionKey).toBe("voice-session-123");
      }
    });

    it("handles optional temperature", async () => {
      const req = createMockRequest({
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.7,
      });
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.temperature).toBe(0.7);
      }
    });

    it("handles optional max_tokens", async () => {
      const req = createMockRequest({
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 1000,
      });
      const result = await parseOpenAIChatRequest(req);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.maxTokens).toBe(1000);
      }
    });
  });
});

describe("messagesToClawdbotFormat", () => {
  it("extracts last user message as primary message", () => {
    const messages = [
      { role: "user" as const, content: "First question" },
      { role: "assistant" as const, content: "First answer" },
      { role: "user" as const, content: "Second question" },
    ];
    const result = messagesToClawdbotFormat(messages);

    expect(result.message).toBe("Second question");
  });

  it("extracts system message as system prompt", () => {
    const messages = [
      { role: "system" as const, content: "You are a helpful assistant" },
      { role: "user" as const, content: "Hello" },
    ];
    const result = messagesToClawdbotFormat(messages);

    expect(result.systemPrompt).toBe("You are a helpful assistant");
    expect(result.message).toBe("Hello");
  });

  it("concatenates multiple system messages", () => {
    const messages = [
      { role: "system" as const, content: "First system instruction" },
      { role: "system" as const, content: "Second system instruction" },
      { role: "user" as const, content: "Hello" },
    ];
    const result = messagesToClawdbotFormat(messages);

    expect(result.systemPrompt).toBe(
      "First system instruction\n\nSecond system instruction",
    );
  });

  it("returns undefined systemPrompt when no system messages", () => {
    const messages = [{ role: "user" as const, content: "Hello" }];
    const result = messagesToClawdbotFormat(messages);

    expect(result.systemPrompt).toBeUndefined();
  });

  it("handles empty user messages by falling back to all non-system", () => {
    const messages = [{ role: "assistant" as const, content: "I am ready" }];
    const result = messagesToClawdbotFormat(messages);

    expect(result.message).toBe("I am ready");
  });
});
