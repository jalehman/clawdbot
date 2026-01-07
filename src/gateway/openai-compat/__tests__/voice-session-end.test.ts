/**
 * Tests for the voice session end endpoint handler.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../../../config/types.js";
import {
  clearVoiceSessions,
  getOrCreateVoiceSession,
  getVoiceSession,
} from "../voice-session.js";
import { createVoiceSessionEndHandler } from "../voice-session-end.js";

// Mock the session store functions
vi.mock("../../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({})),
  saveSessionStore: vi.fn(async () => {}),
  resolveStorePath: vi.fn(() => "/mock/store/path"),
}));

/**
 * Create a mock config for testing.
 */
function createMockConfig(overrides?: Partial<ClawdbotConfig>): ClawdbotConfig {
  return {
    openaiCompat: {
      apiKey: "test-api-key",
      defaultSessionKey: "agent:main:test",
    },
    ...overrides,
  } as ClawdbotConfig;
}

/**
 * Create a mock HTTP request.
 */
function createMockRequest(opts: {
  url?: string;
  method?: string;
  authHeader?: string;
  body?: object;
}): IncomingMessage & { body?: object } {
  const req = {
    url: opts.url ?? "/v1/voice/session/end",
    method: opts.method ?? "POST",
    headers: {
      host: "localhost:18789",
      ...(opts.authHeader !== undefined
        ? { authorization: opts.authHeader }
        : { authorization: "Bearer test-api-key" }),
    },
    body: opts.body,
    on: vi.fn((event: string, callback: (data?: Buffer) => void) => {
      if (event === "data" && opts.body) {
        callback(Buffer.from(JSON.stringify(opts.body)));
      }
      if (event === "end") {
        callback();
      }
    }),
  } as unknown as IncomingMessage & { body?: object };
  return req;
}

/**
 * Create a mock HTTP response.
 */
function createMockResponse(): ServerResponse & {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
} {
  const res = {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    setHeader: vi.fn((name: string, value: string) => {
      res.headers[name.toLowerCase()] = value;
    }),
    end: vi.fn((data?: string) => {
      if (data) {
        try {
          res.body = JSON.parse(data);
        } catch {
          res.body = data;
        }
      }
    }),
  } as unknown as ServerResponse & {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
  };
  return res;
}

/**
 * Create handler with default deps.
 */
function createHandler(configOverrides?: Partial<ClawdbotConfig>) {
  const config = createMockConfig(configOverrides);
  return createVoiceSessionEndHandler({
    getConfig: () => config,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });
}

describe("createVoiceSessionEndHandler", () => {
  beforeEach(() => {
    clearVoiceSessions();
  });

  describe("routing", () => {
    it("handles POST /v1/voice/session/end", async () => {
      const handler = createHandler();
      const req = createMockRequest({});
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
    });

    it("returns false for other paths", async () => {
      const handler = createHandler();
      const req = createMockRequest({ url: "/v1/chat/completions" });
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(false);
    });

    it("rejects non-POST methods", async () => {
      const handler = createHandler();
      const req = createMockRequest({ method: "GET" });
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(405);
    });
  });

  describe("authentication", () => {
    it("rejects missing Authorization header", async () => {
      const handler = createHandler();
      const req = createMockRequest({ authHeader: undefined });
      // Remove authorization header
      delete req.headers.authorization;
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect((res.body as { error?: { type?: string } })?.error?.type).toBe(
        "authentication_error",
      );
    });

    it("rejects invalid API key", async () => {
      const handler = createHandler();
      const req = createMockRequest({ authHeader: "Bearer wrong-key" });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(401);
    });

    it("accepts valid Bearer token", async () => {
      const handler = createHandler();
      const config = createMockConfig();

      // Create a voice session first
      await getOrCreateVoiceSession({
        mainSessionKey: "agent:main:test",
        voiceSessionId: "voice-test",
        config,
      });

      const req = createMockRequest({
        authHeader: "Bearer test-api-key",
        body: { conversation_id: "voice-test" },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });
  });

  describe("session ending", () => {
    it("ends active voice session and returns success", async () => {
      const config = createMockConfig();
      const handler = createHandler();

      // Create a voice session
      const session = await getOrCreateVoiceSession({
        mainSessionKey: "agent:main:test",
        voiceSessionId: "voice-end-test",
        config,
      });

      // Verify it exists
      expect(getVoiceSession("voice-end-test")).toBeDefined();

      const req = createMockRequest({
        body: { conversation_id: "voice-end-test" },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect((res.body as { success?: boolean })?.success).toBe(true);
      expect((res.body as { turns?: number })?.turns).toBe(1);
      expect((res.body as { duration?: string })?.duration).toBeDefined();

      // Verify session is ended
      expect(getVoiceSession("voice-end-test")).toBeUndefined();
    });

    it("returns 404 when voice session not found", async () => {
      const handler = createHandler();

      const req = createMockRequest({
        body: { conversation_id: "nonexistent-session" },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect((res.body as { success?: boolean })?.success).toBe(false);
      expect((res.body as { error?: string })?.error).toContain("not found");
    });

    it("returns 404 when no active sessions exist", async () => {
      const handler = createHandler();

      const req = createMockRequest({ body: {} });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect((res.body as { error?: string })?.error).toContain(
        "No active voice sessions",
      );
    });

    it("ends single active session when no conversation_id provided", async () => {
      const config = createMockConfig();
      const handler = createHandler();

      // Create a single voice session
      await getOrCreateVoiceSession({
        mainSessionKey: "agent:main:auto",
        voiceSessionId: "voice-auto",
        config,
      });

      const req = createMockRequest({ body: {} });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect((res.body as { success?: boolean })?.success).toBe(true);
      expect(getVoiceSession("voice-auto")).toBeUndefined();
    });

    it("returns error when multiple sessions active and no conversation_id", async () => {
      const config = createMockConfig();
      const handler = createHandler();

      // Create multiple voice sessions
      await getOrCreateVoiceSession({
        mainSessionKey: "agent:main:multi-1",
        voiceSessionId: "voice-multi-1",
        config,
      });
      await getOrCreateVoiceSession({
        mainSessionKey: "agent:main:multi-2",
        voiceSessionId: "voice-multi-2",
        config,
      });

      const req = createMockRequest({ body: {} });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect((res.body as { error?: string })?.error).toContain(
        "Multiple active voice sessions",
      );
    });
  });

  describe("webhook summary support", () => {
    it("uses provided summary from webhook", async () => {
      const config = createMockConfig({
        openaiCompat: {
          apiKey: "test-api-key",
          autoCompact: true,
        },
      });
      const handler = createVoiceSessionEndHandler({
        getConfig: () => config,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      // Create a voice session
      await getOrCreateVoiceSession({
        mainSessionKey: "agent:main:summary",
        voiceSessionId: "voice-summary",
        config,
      });

      const req = createMockRequest({
        body: {
          conversation_id: "voice-summary",
          summary: "User discussed project planning",
        },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect((res.body as { success?: boolean })?.success).toBe(true);
      expect((res.body as { summary?: string })?.summary).toContain(
        "User discussed project planning",
      );
    });
  });

  describe("compactionSource config", () => {
    it("'webhook' mode requires summary in request", async () => {
      const config = createMockConfig({
        openaiCompat: {
          apiKey: "test-api-key",
          autoCompact: true,
          compactionSource: "webhook",
        },
      });
      const handler = createVoiceSessionEndHandler({
        getConfig: () => config,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      await getOrCreateVoiceSession({
        mainSessionKey: "agent:main:webhook-required",
        voiceSessionId: "voice-webhook-required",
        config,
      });

      // Request without summary should fail
      const req = createMockRequest({
        body: { conversation_id: "voice-webhook-required" },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect((res.body as { error?: string })?.error).toContain(
        "Summary required",
      );
    });

    it("'webhook' mode accepts provided summary", async () => {
      const config = createMockConfig({
        openaiCompat: {
          apiKey: "test-api-key",
          autoCompact: true,
          compactionSource: "webhook",
        },
      });
      const handler = createVoiceSessionEndHandler({
        getConfig: () => config,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      await getOrCreateVoiceSession({
        mainSessionKey: "agent:main:webhook-ok",
        voiceSessionId: "voice-webhook-ok",
        config,
      });

      const req = createMockRequest({
        body: {
          conversation_id: "voice-webhook-ok",
          summary: "Webhook-provided summary",
        },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect((res.body as { summary?: string })?.summary).toContain(
        "Webhook-provided summary",
      );
    });

    it("'auto' mode uses webhook summary when provided", async () => {
      const config = createMockConfig({
        openaiCompat: {
          apiKey: "test-api-key",
          autoCompact: true,
          compactionSource: "auto",
        },
      });
      const handler = createVoiceSessionEndHandler({
        getConfig: () => config,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      await getOrCreateVoiceSession({
        mainSessionKey: "agent:main:auto-webhook",
        voiceSessionId: "voice-auto-webhook",
        config,
      });

      const req = createMockRequest({
        body: {
          conversation_id: "voice-auto-webhook",
          summary: "Auto mode webhook summary",
        },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect((res.body as { summary?: string })?.summary).toContain(
        "Auto mode webhook summary",
      );
    });

    it("'auto' mode works without summary (falls back to generator)", async () => {
      const config = createMockConfig({
        openaiCompat: {
          apiKey: "test-api-key",
          autoCompact: true,
          compactionSource: "auto",
        },
      });
      const generateSummary = vi.fn().mockResolvedValue("Generated summary");
      const handler = createVoiceSessionEndHandler({
        getConfig: () => config,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        generateSummary,
      });

      await getOrCreateVoiceSession({
        mainSessionKey: "agent:main:auto-gen",
        voiceSessionId: "voice-auto-gen",
        config,
      });

      const req = createMockRequest({
        body: { conversation_id: "voice-auto-gen" },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(generateSummary).toHaveBeenCalled();
    });
  });

  describe("request body parsing", () => {
    it("handles empty request body", async () => {
      const config = createMockConfig();
      const handler = createHandler();

      // Create a single session so empty body works
      await getOrCreateVoiceSession({
        mainSessionKey: "agent:main:empty",
        voiceSessionId: "voice-empty",
        config,
      });

      // Override the mock to return empty body
      const req = {
        url: "/v1/voice/session/end",
        method: "POST",
        headers: {
          host: "localhost:18789",
          authorization: "Bearer test-api-key",
        },
        on: vi.fn((event: string, callback: (data?: Buffer) => void) => {
          if (event === "end") {
            callback();
          }
        }),
      } as unknown as IncomingMessage;
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });

    it("accepts optional reason field", async () => {
      const config = createMockConfig();
      const handler = createHandler();

      await getOrCreateVoiceSession({
        mainSessionKey: "agent:main:reason",
        voiceSessionId: "voice-reason",
        config,
      });

      const req = createMockRequest({
        body: {
          conversation_id: "voice-reason",
          reason: "user hung up",
        },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect((res.body as { success?: boolean })?.success).toBe(true);
    });
  });
});
