/**
 * Pre-warmed voice session pool.
 *
 * Maintains pre-warmed voice sessions ready for immediate use when a call arrives.
 * This eliminates cold-start latency by having sessions with workspace loaded,
 * memory read, and tools initialized before the call begins.
 *
 * ## Architecture
 * - Pool maintains one pre-warmed session per main session key
 * - Sessions are created with full context from the main session
 * - High-water mark tracking allows efficient delta sync on call arrival
 * - After a call ends, the used session is rotated with a fresh one
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveSessionTranscriptPath,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../../config/sessions.js";
import type { ClawdbotConfig } from "../../config/types.js";
import { DEFAULT_VOICE_MODEL, type VoiceSessionInfo } from "./voice-session.js";

/**
 * Pre-warmed session state tracked for each main session key.
 */
export type PreWarmedSession = {
  /** Unique ID for this pre-warmed session. */
  id: string;
  /** The main session key this pre-warmed session belongs to. */
  mainSessionKey: string;
  /** The ephemeral session key for voice interactions. */
  ephemeralSessionKey: string;
  /** Session ID (UUID) for the ephemeral transcript. */
  ephemeralSessionId: string;
  /** Model being used for voice. */
  model: string;
  /** Timestamp when session was warmed up. */
  warmedAt: number;
  /**
   * High-water mark: number of lines in main session transcript
   * that have been synced to this pre-warmed session.
   */
  highWaterMark: number;
  /**
   * Hash of the main session transcript at time of last sync.
   * Used to detect compaction (when hash changes but line count decreased).
   */
  transcriptHash?: string;
  /** Whether this session is currently in use (active call). */
  inUse: boolean;
};

/**
 * Configuration for the voice session pool.
 */
export type VoiceSessionPoolConfig = {
  /** Whether pre-warming is enabled (default: false). */
  enabled: boolean;
  /** Model to use for voice sessions. */
  voiceModel?: string;
  /** Interval in ms between warmup checks (default: 60000 = 1 minute). */
  warmupIntervalMs?: number;
  /** Maximum age of a pre-warmed session before refresh (default: 3600000 = 1 hour). */
  maxSessionAgeMs?: number;
};

/**
 * Logger interface for pool operations.
 */
export type PoolLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

/**
 * In-memory pool of pre-warmed voice sessions.
 * Maps main session key to pre-warmed session state.
 */
const preWarmedSessions = new Map<string, PreWarmedSession>();

/** Warmup interval timer handle. */
let warmupIntervalHandle: ReturnType<typeof setInterval> | null = null;

/** Pool configuration. */
let poolConfig: VoiceSessionPoolConfig = { enabled: false };

/** Reference to config getter. */
let getConfigRef: (() => ClawdbotConfig) | null = null;

/** Logger reference. */
let logRef: PoolLogger | null = null;

/**
 * Compute a simple hash of transcript content for detecting changes.
 * Uses first 100 chars + last 100 chars + length for efficiency.
 */
function computeTranscriptHash(content: string): string {
  const prefix = content.slice(0, 100);
  const suffix = content.slice(-100);
  const len = content.length;
  return `${len}:${hashString(prefix + suffix)}`;
}

/**
 * Simple string hash (djb2 algorithm).
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

/**
 * Copy transcript from main session to ephemeral voice session.
 * Returns the number of lines copied and transcript hash.
 */
async function copyMainSessionContext(params: {
  mainSessionId: string;
  ephemeralSessionId: string;
  mainSessionKey: string;
  log?: PoolLogger;
}): Promise<{ lineCount: number; hash: string }> {
  const { mainSessionId, ephemeralSessionId, mainSessionKey, log } = params;
  const agentId = resolveAgentIdFromSessionKey(mainSessionKey);

  const mainTranscriptPath = resolveSessionTranscriptPath(
    mainSessionId,
    agentId,
  );
  const ephemeralTranscriptPath = resolveSessionTranscriptPath(
    ephemeralSessionId,
    agentId,
  );

  if (!fs.existsSync(mainTranscriptPath)) {
    log?.info(
      `No main session transcript to copy (${mainSessionId}); starting fresh`,
    );
    return { lineCount: 0, hash: "" };
  }

  try {
    const transcriptDir = path.dirname(ephemeralTranscriptPath);
    await fs.promises.mkdir(transcriptDir, { recursive: true });
    await fs.promises.copyFile(mainTranscriptPath, ephemeralTranscriptPath);

    const content = await fs.promises.readFile(mainTranscriptPath, "utf-8");
    const lineCount = content.split("\n").filter((line) => line.trim()).length;
    const hash = computeTranscriptHash(content);

    log?.info(
      `Copied main session context (${mainSessionId}) to pre-warmed session (${ephemeralSessionId}): ${lineCount} lines`,
    );

    return { lineCount, hash };
  } catch (err) {
    log?.warn(`Could not copy main session context: ${err}`);
    return { lineCount: 0, hash: "" };
  }
}

/**
 * Create a new pre-warmed session for a main session key.
 */
async function createPreWarmedSession(
  mainSessionKey: string,
  config: ClawdbotConfig,
  log?: PoolLogger,
): Promise<PreWarmedSession> {
  const openaiConfig = config.openaiCompat ?? {};
  const id = `prewarm-${randomUUID().slice(0, 8)}`;
  const ephemeralSessionId = randomUUID();
  const ephemeralSessionKey = `${mainSessionKey}:voice:${id}`;
  const model = openaiConfig.voiceModel || DEFAULT_VOICE_MODEL;

  // Create ephemeral session entry in the store
  const storePath = resolveStorePath(config.session?.store);
  const store = loadSessionStore(storePath);

  // Copy relevant settings from main session if it exists
  const mainSession = store[mainSessionKey];
  const ephemeralEntry: SessionEntry = {
    sessionId: ephemeralSessionId,
    updatedAt: Date.now(),
    spawnedBy: mainSessionKey,
    modelOverride: model,
    chatType: "direct",
    thinkingLevel: mainSession?.thinkingLevel,
    verboseLevel: mainSession?.verboseLevel,
  };

  store[ephemeralSessionKey] = ephemeralEntry;
  await saveSessionStore(storePath, store);

  // Copy context from main session and get line count
  let highWaterMark = 0;
  let transcriptHash = "";
  if (mainSession?.sessionId) {
    const result = await copyMainSessionContext({
      mainSessionId: mainSession.sessionId,
      ephemeralSessionId,
      mainSessionKey,
      log,
    });
    highWaterMark = result.lineCount;
    transcriptHash = result.hash;
  }

  const preWarmed: PreWarmedSession = {
    id,
    mainSessionKey,
    ephemeralSessionKey,
    ephemeralSessionId,
    model,
    warmedAt: Date.now(),
    highWaterMark,
    transcriptHash,
    inUse: false,
  };

  preWarmedSessions.set(mainSessionKey, preWarmed);
  log?.info(
    `Created pre-warmed voice session ${id} for main session ${mainSessionKey}`,
  );

  return preWarmed;
}

/**
 * Initialize the voice session pool.
 */
export function initVoiceSessionPool(params: {
  getConfig: () => ClawdbotConfig;
  log: PoolLogger;
}): void {
  const { getConfig, log } = params;
  getConfigRef = getConfig;
  logRef = log;

  const config = getConfig();
  const openaiConfig = config.openaiCompat ?? {};

  // Build pool config from openaiCompat settings
  poolConfig = {
    enabled: openaiConfig.preWarmVoiceSessions ?? false,
    voiceModel: openaiConfig.voiceModel,
    warmupIntervalMs: openaiConfig.warmupIntervalMs ?? 60000,
    maxSessionAgeMs: openaiConfig.maxSessionAgeMs ?? 3600000,
  };

  if (!poolConfig.enabled) {
    log.info("Voice session pool: pre-warming disabled");
    return;
  }

  log.info(
    `Voice session pool: initialized with warmup interval ${poolConfig.warmupIntervalMs}ms`,
  );

  // Start warmup interval
  startWarmupInterval();
}

/**
 * Start the periodic warmup check interval.
 */
function startWarmupInterval(): void {
  if (warmupIntervalHandle) return;
  if (!poolConfig.enabled || !poolConfig.warmupIntervalMs) return;

  warmupIntervalHandle = setInterval(
    () => runWarmupCheck(),
    poolConfig.warmupIntervalMs,
  );
}

/**
 * Stop the warmup interval.
 */
export function stopVoiceSessionPool(): void {
  if (warmupIntervalHandle) {
    clearInterval(warmupIntervalHandle);
    warmupIntervalHandle = null;
  }
  preWarmedSessions.clear();
  logRef?.info("Voice session pool: stopped");
}

/**
 * Run periodic warmup check.
 * - Refreshes sessions that are too old
 * - Creates sessions for main session keys that need them
 */
async function runWarmupCheck(): Promise<void> {
  if (!getConfigRef || !logRef) return;

  const config = getConfigRef();
  const now = Date.now();

  // Check existing pre-warmed sessions
  for (const [mainKey, session] of preWarmedSessions.entries()) {
    // Skip sessions in use
    if (session.inUse) continue;

    // Refresh if too old
    const age = now - session.warmedAt;
    if (poolConfig.maxSessionAgeMs && age > poolConfig.maxSessionAgeMs) {
      logRef.info(
        `Refreshing stale pre-warmed session ${session.id} (age: ${Math.round(age / 1000)}s)`,
      );
      await createPreWarmedSession(mainKey, config, logRef);
    }
  }
}

/**
 * Ensure a pre-warmed session exists for the given main session key.
 * Creates one if it doesn't exist.
 */
export async function ensurePreWarmedSession(
  mainSessionKey: string,
): Promise<PreWarmedSession | null> {
  if (!poolConfig.enabled || !getConfigRef || !logRef) {
    return null;
  }

  const existing = preWarmedSessions.get(mainSessionKey);
  if (existing && !existing.inUse) {
    return existing;
  }

  // Create a new pre-warmed session
  const config = getConfigRef();
  return createPreWarmedSession(mainSessionKey, config, logRef);
}

/**
 * Get a pre-warmed session for use.
 * Marks the session as in-use.
 */
export function acquirePreWarmedSession(
  mainSessionKey: string,
): PreWarmedSession | null {
  const session = preWarmedSessions.get(mainSessionKey);
  if (!session || session.inUse) {
    return null;
  }

  session.inUse = true;
  logRef?.info(`Acquired pre-warmed session ${session.id} for voice call`);
  return session;
}

/**
 * Release a pre-warmed session after use.
 * Triggers rotation to prepare a fresh session.
 */
export async function releasePreWarmedSession(
  sessionId: string,
): Promise<void> {
  for (const [mainKey, session] of preWarmedSessions.entries()) {
    if (session.id === sessionId) {
      logRef?.info(`Releasing pre-warmed session ${sessionId}, will rotate`);

      // Remove the used session
      preWarmedSessions.delete(mainKey);

      // Create a new pre-warmed session for next time
      if (poolConfig.enabled && getConfigRef) {
        const config = getConfigRef();
        await createPreWarmedSession(mainKey, config, logRef ?? undefined);
      }
      return;
    }
  }
}

/**
 * Convert a pre-warmed session to a VoiceSessionInfo for compatibility
 * with existing voice session handling.
 */
export function toVoiceSessionInfo(
  preWarmed: PreWarmedSession,
): VoiceSessionInfo {
  return {
    voiceSessionId: preWarmed.id,
    mainSessionKey: preWarmed.mainSessionKey,
    ephemeralSessionKey: preWarmed.ephemeralSessionKey,
    ephemeralSessionId: preWarmed.ephemeralSessionId,
    model: preWarmed.model,
    startedAt: Date.now(),
    turnCount: 0,
  };
}

/**
 * Get pool statistics for debugging/monitoring.
 */
export function getPoolStats(): {
  enabled: boolean;
  sessionCount: number;
  inUseCount: number;
  sessions: Array<{
    id: string;
    mainSessionKey: string;
    inUse: boolean;
    age: number;
    highWaterMark: number;
  }>;
} {
  const now = Date.now();
  const sessions = Array.from(preWarmedSessions.values()).map((s) => ({
    id: s.id,
    mainSessionKey: s.mainSessionKey,
    inUse: s.inUse,
    age: Math.round((now - s.warmedAt) / 1000),
    highWaterMark: s.highWaterMark,
  }));

  return {
    enabled: poolConfig.enabled,
    sessionCount: preWarmedSessions.size,
    inUseCount: sessions.filter((s) => s.inUse).length,
    sessions,
  };
}

/**
 * Get a pre-warmed session by its ID.
 */
export function getPreWarmedSessionById(
  sessionId: string,
): PreWarmedSession | undefined {
  for (const session of preWarmedSessions.values()) {
    if (session.id === sessionId) {
      return session;
    }
  }
  return undefined;
}

/**
 * Get all pre-warmed sessions for a main session key.
 */
export function getPreWarmedSessionByMainKey(
  mainSessionKey: string,
): PreWarmedSession | undefined {
  return preWarmedSessions.get(mainSessionKey);
}

/**
 * Check if the pool is enabled.
 */
export function isPoolEnabled(): boolean {
  return poolConfig.enabled;
}

/**
 * Clear all pre-warmed sessions (for testing).
 */
export function clearPreWarmedSessions(): void {
  preWarmedSessions.clear();
}
