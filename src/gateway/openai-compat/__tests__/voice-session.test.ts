/**
 * Tests for voice session forking and management.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../../../config/types.js";
import {
  clearVoiceSessions,
  DEFAULT_VOICE_MODEL,
  endVoiceSession,
  getOrCreateVoiceSession,
  getVoiceSession,
  getVoiceSessionByMainKey,
  getVoiceSessionId,
  isVoiceSessionHeader,
  listActiveVoiceSessions,
} from "../voice-session.js";

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
      apiKey: "test-key",
      defaultSessionKey: "agent:main:test",
    },
    ...overrides,
  } as ClawdbotConfig;
}

describe("isVoiceSessionHeader", () => {
  it("returns true for X-Clawdbot-Voice-Session: true", () => {
    const headers = { "x-clawdbot-voice-session": "true" };
    expect(isVoiceSessionHeader(headers)).toBe(true);
  });

  it("returns true for X-Clawdbot-Voice-Session: 1", () => {
    const headers = { "x-clawdbot-voice-session": "1" };
    expect(isVoiceSessionHeader(headers)).toBe(true);
  });

  it("returns false for missing header", () => {
    const headers = {};
    expect(isVoiceSessionHeader(headers)).toBe(false);
  });

  it("returns false for X-Clawdbot-Voice-Session: false", () => {
    const headers = { "x-clawdbot-voice-session": "false" };
    expect(isVoiceSessionHeader(headers)).toBe(false);
  });

  it("handles array header values", () => {
    const headers = { "x-clawdbot-voice-session": ["true"] };
    expect(isVoiceSessionHeader(headers)).toBe(true);
  });
});

describe("getVoiceSessionId", () => {
  it("returns voice ID from header", () => {
    const headers = { "x-clawdbot-voice-id": "voice-123" };
    expect(getVoiceSessionId(headers)).toBe("voice-123");
  });

  it("returns undefined when header is missing", () => {
    const headers = {};
    expect(getVoiceSessionId(headers)).toBeUndefined();
  });

  it("handles array header values", () => {
    const headers = { "x-clawdbot-voice-id": ["voice-abc", "voice-def"] };
    expect(getVoiceSessionId(headers)).toBe("voice-abc");
  });
});

describe("getOrCreateVoiceSession", () => {
  beforeEach(() => {
    clearVoiceSessions();
  });

  it("creates a new voice session", async () => {
    const config = createMockConfig();
    const session = await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:test",
      config,
    });

    expect(session.voiceSessionId).toMatch(/^voice-/);
    expect(session.mainSessionKey).toBe("agent:main:test");
    expect(session.ephemeralSessionKey).toContain("agent:main:test:voice:");
    expect(session.model).toBe(DEFAULT_VOICE_MODEL);
    expect(session.turnCount).toBe(1);
  });

  it("uses provided voice session ID", async () => {
    const config = createMockConfig();
    const session = await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:test",
      voiceSessionId: "custom-voice-id",
      config,
    });

    expect(session.voiceSessionId).toBe("custom-voice-id");
  });

  it("uses configured voice model", async () => {
    const config = createMockConfig({
      openaiCompat: {
        apiKey: "test-key",
        voiceModel: "custom-fast-model",
      },
    });

    const session = await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:test",
      config,
    });

    expect(session.model).toBe("custom-fast-model");
  });

  it("returns existing session for same voice ID", async () => {
    const config = createMockConfig();

    const session1 = await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:test",
      voiceSessionId: "voice-same",
      config,
    });

    const session2 = await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:test",
      voiceSessionId: "voice-same",
      config,
    });

    expect(session1.voiceSessionId).toBe(session2.voiceSessionId);
    expect(session2.turnCount).toBe(2); // Incremented
  });

  it("returns existing session for same main session key", async () => {
    const config = createMockConfig();

    const session1 = await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:existing",
      config,
    });

    const session2 = await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:existing",
      config,
    });

    expect(session1.voiceSessionId).toBe(session2.voiceSessionId);
    expect(session2.turnCount).toBe(2);
  });
});

describe("getVoiceSession", () => {
  beforeEach(() => {
    clearVoiceSessions();
  });

  it("returns session by ID", async () => {
    const config = createMockConfig();
    const created = await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:test",
      voiceSessionId: "voice-get-test",
      config,
    });

    const retrieved = getVoiceSession("voice-get-test");
    expect(retrieved).toBeDefined();
    expect(retrieved?.voiceSessionId).toBe(created.voiceSessionId);
  });

  it("returns undefined for unknown ID", () => {
    const session = getVoiceSession("nonexistent");
    expect(session).toBeUndefined();
  });
});

describe("getVoiceSessionByMainKey", () => {
  beforeEach(() => {
    clearVoiceSessions();
  });

  it("returns session by main session key", async () => {
    const config = createMockConfig();
    await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:find-by-main",
      config,
    });

    const retrieved = getVoiceSessionByMainKey("agent:main:find-by-main");
    expect(retrieved).toBeDefined();
    expect(retrieved?.mainSessionKey).toBe("agent:main:find-by-main");
  });

  it("returns undefined for unknown main key", () => {
    const session = getVoiceSessionByMainKey("nonexistent");
    expect(session).toBeUndefined();
  });
});

describe("listActiveVoiceSessions", () => {
  beforeEach(() => {
    clearVoiceSessions();
  });

  it("returns empty array when no sessions", () => {
    const sessions = listActiveVoiceSessions();
    expect(sessions).toHaveLength(0);
  });

  it("returns all active sessions", async () => {
    const config = createMockConfig();

    await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:list-1",
      voiceSessionId: "voice-list-1",
      config,
    });

    await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:list-2",
      voiceSessionId: "voice-list-2",
      config,
    });

    const sessions = listActiveVoiceSessions();
    expect(sessions).toHaveLength(2);
  });
});

describe("endVoiceSession", () => {
  beforeEach(() => {
    clearVoiceSessions();
  });

  it("removes session from active sessions", async () => {
    const config = createMockConfig();

    await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:end-test",
      voiceSessionId: "voice-end-test",
      config,
    });

    expect(getVoiceSession("voice-end-test")).toBeDefined();

    await endVoiceSession({
      voiceSessionId: "voice-end-test",
      config,
    });

    expect(getVoiceSession("voice-end-test")).toBeUndefined();
  });

  it("returns compacted: false when session not found", async () => {
    const config = createMockConfig();

    const result = await endVoiceSession({
      voiceSessionId: "nonexistent",
      config,
    });

    expect(result.compacted).toBe(false);
  });

  it("returns compacted: false when no generateSummary provided", async () => {
    const config = createMockConfig();

    await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:no-summary",
      voiceSessionId: "voice-no-summary",
      config,
    });

    const result = await endVoiceSession({
      voiceSessionId: "voice-no-summary",
      config,
    });

    expect(result.compacted).toBe(false);
  });

  it("returns compacted: false when autoCompact is disabled", async () => {
    const config = createMockConfig({
      openaiCompat: {
        apiKey: "test-key",
        autoCompact: false,
      },
    });

    await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:disabled",
      voiceSessionId: "voice-disabled",
      config,
    });

    const result = await endVoiceSession({
      voiceSessionId: "voice-disabled",
      config,
      generateSummary: async () => "summary",
    });

    expect(result.compacted).toBe(false);
  });

  it("compacts session when autoCompact enabled and generateSummary provided", async () => {
    const config = createMockConfig({
      openaiCompat: {
        apiKey: "test-key",
        autoCompact: true,
      },
    });

    await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:compact",
      voiceSessionId: "voice-compact",
      config,
    });

    const result = await endVoiceSession({
      voiceSessionId: "voice-compact",
      config,
      generateSummary: async () => "This was a helpful conversation",
    });

    expect(result.compacted).toBe(true);
    expect(result.summary).toContain("Voice call summary");
    expect(result.summary).toContain("This was a helpful conversation");
  });

  it("handles generateSummary errors gracefully", async () => {
    const config = createMockConfig({
      openaiCompat: {
        apiKey: "test-key",
        autoCompact: true,
      },
    });

    await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:error",
      voiceSessionId: "voice-error",
      config,
    });

    const result = await endVoiceSession({
      voiceSessionId: "voice-error",
      config,
      generateSummary: async () => {
        throw new Error("Summary generation failed");
      },
    });

    expect(result.compacted).toBe(false);
    // Session should still be removed
    expect(getVoiceSession("voice-error")).toBeUndefined();
  });
});

describe("clearVoiceSessions", () => {
  it("removes all active sessions", async () => {
    const config = createMockConfig();

    await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:clear-1",
      voiceSessionId: "voice-clear-1",
      config,
    });

    await getOrCreateVoiceSession({
      mainSessionKey: "agent:main:clear-2",
      voiceSessionId: "voice-clear-2",
      config,
    });

    expect(listActiveVoiceSessions()).toHaveLength(2);

    clearVoiceSessions();

    expect(listActiveVoiceSessions()).toHaveLength(0);
  });
});
