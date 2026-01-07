/**
 * Tests for pre-warmed voice session pool.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../../../config/types.js";
import {
  acquirePreWarmedSession,
  acquirePreWarmedSessionWithSync,
  clearPreWarmedSessions,
  ensurePreWarmedSession,
  getPoolStats,
  getPreWarmedSessionById,
  getPreWarmedSessionByMainKey,
  initVoiceSessionPool,
  isPoolEnabled,
  releasePreWarmedSession,
  stopVoiceSessionPool,
  toVoiceSessionInfo,
} from "../voice-session-pool.js";

const TEST_DIR = "/tmp/clawdbot-test-pool-sessions";

// Mock the session store functions
vi.mock("../../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({})),
  saveSessionStore: vi.fn(async () => {}),
  resolveStorePath: vi.fn(() => "/mock/store/path"),
  resolveAgentIdFromSessionKey: vi.fn(() => "clawd"),
  resolveSessionTranscriptPath: vi.fn(
    (sessionId: string) => `${TEST_DIR}/${sessionId}.jsonl`,
  ),
}));

/**
 * Create a mock config for testing.
 */
function createMockConfig(overrides?: Partial<ClawdbotConfig>): ClawdbotConfig {
  return {
    openaiCompat: {
      apiKey: "test-key",
      defaultSessionKey: "agent:main:test",
      preWarmVoiceSessions: true,
      warmupIntervalMs: 60000,
      maxSessionAgeMs: 3600000,
    },
    ...overrides,
  } as ClawdbotConfig;
}

/**
 * Create a mock logger.
 */
function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("voice session pool initialization", () => {
  beforeEach(() => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
  });

  afterEach(() => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
  });

  it("initializes pool with preWarmVoiceSessions enabled", () => {
    const config = createMockConfig();
    const logger = createMockLogger();

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    expect(isPoolEnabled()).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("initialized with warmup interval"),
    );
  });

  it("does not enable pool when preWarmVoiceSessions is false", () => {
    const config = createMockConfig({
      openaiCompat: {
        apiKey: "test-key",
        preWarmVoiceSessions: false,
      },
    });
    const logger = createMockLogger();

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    expect(isPoolEnabled()).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("pre-warming disabled"),
    );
  });

  it("stops pool and clears sessions", () => {
    const config = createMockConfig();
    const logger = createMockLogger();

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    expect(isPoolEnabled()).toBe(true);

    stopVoiceSessionPool();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("stopped"),
    );
  });
});

describe("ensurePreWarmedSession", () => {
  beforeEach(async () => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
    // Create test directory
    await fs.promises.mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
    // Clean up test files
    const files = await fs.promises.readdir(TEST_DIR).catch(() => []);
    for (const file of files) {
      await fs.promises.unlink(path.join(TEST_DIR, file)).catch(() => {});
    }
  });

  it("creates a new pre-warmed session when pool is enabled", async () => {
    const config = createMockConfig();
    const logger = createMockLogger();

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    const session = await ensurePreWarmedSession("agent:main:test");

    expect(session).not.toBeNull();
    expect(session?.id).toMatch(/^prewarm-/);
    expect(session?.mainSessionKey).toBe("agent:main:test");
    expect(session?.inUse).toBe(false);
    expect(session?.highWaterMark).toBe(0);
  });

  it("returns null when pool is not enabled", async () => {
    const config = createMockConfig({
      openaiCompat: {
        apiKey: "test-key",
        preWarmVoiceSessions: false,
      },
    });
    const logger = createMockLogger();

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    const session = await ensurePreWarmedSession("agent:main:test");

    expect(session).toBeNull();
  });

  it("returns existing session if already pre-warmed", async () => {
    const config = createMockConfig();
    const logger = createMockLogger();

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    const session1 = await ensurePreWarmedSession("agent:main:test");
    const session2 = await ensurePreWarmedSession("agent:main:test");

    expect(session1?.id).toBe(session2?.id);
  });
});

describe("acquirePreWarmedSession", () => {
  beforeEach(async () => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
    await fs.promises.mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
    const files = await fs.promises.readdir(TEST_DIR).catch(() => []);
    for (const file of files) {
      await fs.promises.unlink(path.join(TEST_DIR, file)).catch(() => {});
    }
  });

  it("marks session as in use when acquired", async () => {
    const config = createMockConfig();
    const logger = createMockLogger();

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    await ensurePreWarmedSession("agent:main:test");
    const acquired = acquirePreWarmedSession("agent:main:test");

    expect(acquired).not.toBeNull();
    expect(acquired?.inUse).toBe(true);
  });

  it("returns null when session is already in use", async () => {
    const config = createMockConfig();
    const logger = createMockLogger();

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    await ensurePreWarmedSession("agent:main:test");
    acquirePreWarmedSession("agent:main:test");
    const second = acquirePreWarmedSession("agent:main:test");

    expect(second).toBeNull();
  });

  it("returns null when no pre-warmed session exists", () => {
    const config = createMockConfig();
    const logger = createMockLogger();

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    const session = acquirePreWarmedSession("agent:main:nonexistent");

    expect(session).toBeNull();
  });
});

describe("releasePreWarmedSession", () => {
  beforeEach(async () => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
    await fs.promises.mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
    const files = await fs.promises.readdir(TEST_DIR).catch(() => []);
    for (const file of files) {
      await fs.promises.unlink(path.join(TEST_DIR, file)).catch(() => {});
    }
  });

  it("creates a new pre-warmed session after release", async () => {
    const config = createMockConfig();
    const logger = createMockLogger();

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    await ensurePreWarmedSession("agent:main:test");
    const acquired = acquirePreWarmedSession("agent:main:test");

    expect(acquired).not.toBeNull();
    const originalId = acquired!.id;

    await releasePreWarmedSession(originalId);

    // A new session should have been created
    const newSession = getPreWarmedSessionByMainKey("agent:main:test");
    expect(newSession).not.toBeNull();
    expect(newSession?.id).not.toBe(originalId);
    expect(newSession?.inUse).toBe(false);
  });
});

describe("acquirePreWarmedSessionWithSync (delta sync)", () => {
  const mainSessionId = "main-session-uuid-delta";

  beforeEach(async () => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
    await fs.promises.mkdir(TEST_DIR, { recursive: true });
    // Clean up any leftover test files
    const files = await fs.promises.readdir(TEST_DIR).catch(() => []);
    for (const file of files) {
      await fs.promises.unlink(path.join(TEST_DIR, file)).catch(() => {});
    }
  });

  afterEach(async () => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
    const files = await fs.promises.readdir(TEST_DIR).catch(() => []);
    for (const file of files) {
      await fs.promises.unlink(path.join(TEST_DIR, file)).catch(() => {});
    }
  });

  it("syncs new messages from main session", async () => {
    const config = createMockConfig();
    const logger = createMockLogger();

    // Mock loadSessionStore to return main session with sessionId
    const sessions = await import("../../../config/sessions.js");
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:delta-test": {
        sessionId: mainSessionId,
        updatedAt: Date.now(),
      },
    });

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    // Create initial main session transcript with 2 messages
    const mainTranscriptPath = path.join(TEST_DIR, `${mainSessionId}.jsonl`);
    const initialContent = [
      JSON.stringify({ message: { role: "user", content: "Hello" } }),
      JSON.stringify({ message: { role: "assistant", content: "Hi there!" } }),
    ].join("\n");
    await fs.promises.writeFile(mainTranscriptPath, initialContent);

    // Create pre-warmed session (this copies the initial transcript)
    await ensurePreWarmedSession("agent:main:delta-test");

    // Now add more messages to the main session
    const updatedContent = [
      JSON.stringify({ message: { role: "user", content: "Hello" } }),
      JSON.stringify({ message: { role: "assistant", content: "Hi there!" } }),
      JSON.stringify({ message: { role: "user", content: "New message" } }),
      JSON.stringify({
        message: { role: "assistant", content: "New response" },
      }),
    ].join("\n");
    await fs.promises.writeFile(mainTranscriptPath, updatedContent);

    // Acquire with sync - should delta sync the new messages
    const session = await acquirePreWarmedSessionWithSync(
      "agent:main:delta-test",
      config,
    );

    expect(session).not.toBeNull();
    expect(session?.inUse).toBe(true);
    // High water mark should be updated to 4 (all messages)
    expect(session?.highWaterMark).toBe(4);

    // Check that the ephemeral transcript has all messages
    const ephemeralPath = path.join(
      TEST_DIR,
      `${session?.ephemeralSessionId}.jsonl`,
    );
    const ephemeralContent = await fs.promises.readFile(ephemeralPath, "utf-8");
    const lines = ephemeralContent.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(4);
  });

  it("handles no new messages gracefully", async () => {
    const config = createMockConfig();
    const logger = createMockLogger();

    const sessions = await import("../../../config/sessions.js");
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:no-delta": {
        sessionId: mainSessionId,
        updatedAt: Date.now(),
      },
    });

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    // Create main session transcript
    const mainTranscriptPath = path.join(TEST_DIR, `${mainSessionId}.jsonl`);
    const content = [
      JSON.stringify({ message: { role: "user", content: "Hello" } }),
      JSON.stringify({ message: { role: "assistant", content: "Hi!" } }),
    ].join("\n");
    await fs.promises.writeFile(mainTranscriptPath, content);

    // Create pre-warmed session
    await ensurePreWarmedSession("agent:main:no-delta");

    // Acquire without adding new messages
    const session = await acquirePreWarmedSessionWithSync(
      "agent:main:no-delta",
      config,
    );

    expect(session).not.toBeNull();
    // High water mark should stay at 2
    expect(session?.highWaterMark).toBe(2);
  });
});

describe("toVoiceSessionInfo", () => {
  beforeEach(async () => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
    await fs.promises.mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
    const files = await fs.promises.readdir(TEST_DIR).catch(() => []);
    for (const file of files) {
      await fs.promises.unlink(path.join(TEST_DIR, file)).catch(() => {});
    }
  });

  it("converts pre-warmed session to VoiceSessionInfo", async () => {
    const config = createMockConfig();
    const logger = createMockLogger();

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    const preWarmed = await ensurePreWarmedSession("agent:main:convert");
    expect(preWarmed).not.toBeNull();

    const voiceInfo = toVoiceSessionInfo(preWarmed!);

    expect(voiceInfo.voiceSessionId).toBe(preWarmed!.id);
    expect(voiceInfo.mainSessionKey).toBe("agent:main:convert");
    expect(voiceInfo.ephemeralSessionKey).toBe(preWarmed!.ephemeralSessionKey);
    expect(voiceInfo.model).toBe(preWarmed!.model);
    expect(voiceInfo.turnCount).toBe(0);
  });
});

describe("getPoolStats", () => {
  beforeEach(async () => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
    await fs.promises.mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
    const files = await fs.promises.readdir(TEST_DIR).catch(() => []);
    for (const file of files) {
      await fs.promises.unlink(path.join(TEST_DIR, file)).catch(() => {});
    }
  });

  it("returns correct stats for pool", async () => {
    const config = createMockConfig();
    const logger = createMockLogger();

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    await ensurePreWarmedSession("agent:main:stats-1");
    await ensurePreWarmedSession("agent:main:stats-2");
    acquirePreWarmedSession("agent:main:stats-1");

    const stats = getPoolStats();

    expect(stats.enabled).toBe(true);
    expect(stats.sessionCount).toBe(2);
    expect(stats.inUseCount).toBe(1);
    expect(stats.sessions).toHaveLength(2);
  });
});

describe("getPreWarmedSessionById", () => {
  beforeEach(async () => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
    await fs.promises.mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    clearPreWarmedSessions();
    stopVoiceSessionPool();
    const files = await fs.promises.readdir(TEST_DIR).catch(() => []);
    for (const file of files) {
      await fs.promises.unlink(path.join(TEST_DIR, file)).catch(() => {});
    }
  });

  it("finds session by ID", async () => {
    const config = createMockConfig();
    const logger = createMockLogger();

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    const created = await ensurePreWarmedSession("agent:main:find");
    expect(created).not.toBeNull();

    const found = getPreWarmedSessionById(created!.id);

    expect(found).not.toBeNull();
    expect(found?.id).toBe(created!.id);
  });

  it("returns undefined for unknown ID", () => {
    const config = createMockConfig();
    const logger = createMockLogger();

    initVoiceSessionPool({
      getConfig: () => config,
      log: logger,
    });

    const found = getPreWarmedSessionById("nonexistent-id");

    expect(found).toBeUndefined();
  });
});
