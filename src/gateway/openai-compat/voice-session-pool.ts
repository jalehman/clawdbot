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
import { compactEmbeddedPiSession } from "../../agents/pi-embedded.js";
import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  ensureAgentWorkspace,
} from "../../agents/workspace.js";
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
 * Default threshold for pre-compaction during warmup.
 * Sessions with more lines than this will be compacted during warmup
 * to avoid compaction latency during voice requests.
 */
const DEFAULT_PRECOMPACT_THRESHOLD = 50;

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
 * Perform delta sync: append only new lines from main session to voice session.
 * This is called when a call arrives to inject any messages added since warmup.
 *
 * @returns Object with deltaLines (number of new lines synced) and newHighWaterMark
 */
async function syncDelta(params: {
  preWarmedSession: PreWarmedSession;
  mainSessionId: string;
  config: ClawdbotConfig;
  log?: PoolLogger;
}): Promise<{ deltaLines: number; newHighWaterMark: number; newHash: string }> {
  const { preWarmedSession, mainSessionId, log } = params;
  const agentId = resolveAgentIdFromSessionKey(preWarmedSession.mainSessionKey);

  const mainTranscriptPath = resolveSessionTranscriptPath(
    mainSessionId,
    agentId,
  );
  const ephemeralTranscriptPath = resolveSessionTranscriptPath(
    preWarmedSession.ephemeralSessionId,
    agentId,
  );

  if (!fs.existsSync(mainTranscriptPath)) {
    log?.info("Delta sync: no main session transcript");
    return {
      deltaLines: 0,
      newHighWaterMark: preWarmedSession.highWaterMark,
      newHash: preWarmedSession.transcriptHash ?? "",
    };
  }

  try {
    const content = await fs.promises.readFile(mainTranscriptPath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());
    const currentLineCount = lines.length;
    const currentHash = computeTranscriptHash(content);

    // Check if main session was compacted (hash changed AND line count decreased)
    const previousHash = preWarmedSession.transcriptHash ?? "";
    const wasCompacted =
      previousHash !== "" &&
      currentHash !== previousHash &&
      currentLineCount < preWarmedSession.highWaterMark;

    if (wasCompacted) {
      // Compaction detected - need full refresh, not delta sync
      // Return special marker so caller can handle this
      log?.warn(
        `Delta sync: compaction detected (${preWarmedSession.highWaterMark} -> ${currentLineCount} lines), needs full refresh`,
      );
      return {
        deltaLines: -1, // Special marker indicating compaction
        newHighWaterMark: currentLineCount,
        newHash: currentHash,
      };
    }

    // Calculate delta
    const deltaLines = currentLineCount - preWarmedSession.highWaterMark;

    if (deltaLines <= 0) {
      log?.info(
        `Delta sync: no new messages (${currentLineCount} lines, high-water mark ${preWarmedSession.highWaterMark})`,
      );
      return {
        deltaLines: 0,
        newHighWaterMark: preWarmedSession.highWaterMark,
        newHash: currentHash,
      };
    }

    // Get the new lines to append
    const newLines = lines.slice(preWarmedSession.highWaterMark);

    // Read existing ephemeral content to check if we need a leading newline
    const existingContent = await fs.promises
      .readFile(ephemeralTranscriptPath, "utf-8")
      .catch(() => "");
    const needsLeadingNewline =
      existingContent.length > 0 && !existingContent.endsWith("\n");

    // Build delta content with proper newline handling
    const deltaContent = `${needsLeadingNewline ? "\n" : ""}${newLines.join("\n")}\n`;

    // Append to voice session transcript
    await fs.promises.appendFile(ephemeralTranscriptPath, deltaContent);

    log?.info(
      `Delta sync: appended ${deltaLines} new messages to voice session ${preWarmedSession.id}`,
    );

    return {
      deltaLines,
      newHighWaterMark: currentLineCount,
      newHash: currentHash,
    };
  } catch (err) {
    log?.warn(`Delta sync failed: ${err}`);
    return {
      deltaLines: 0,
      newHighWaterMark: preWarmedSession.highWaterMark,
      newHash: preWarmedSession.transcriptHash ?? "",
    };
  }
}

/**
 * Acquire a pre-warmed session and perform delta sync for immediate use.
 * This is the main entry point for using a pre-warmed session when a call arrives.
 *
 * @returns The session with delta sync completed, or null if no pre-warmed session available
 */
export async function acquirePreWarmedSessionWithSync(
  mainSessionKey: string,
  config: ClawdbotConfig,
): Promise<PreWarmedSession | null> {
  const session = acquirePreWarmedSession(mainSessionKey);
  if (!session) {
    return null;
  }

  // Get main session ID for delta sync
  const storePath = resolveStorePath(config.session?.store);
  const store = loadSessionStore(storePath);
  const mainSession = store[mainSessionKey];

  if (!mainSession?.sessionId) {
    logRef?.info(
      `acquirePreWarmedSessionWithSync: no main session found for ${mainSessionKey}`,
    );
    return session;
  }

  // Perform delta sync
  const result = await syncDelta({
    preWarmedSession: session,
    mainSessionId: mainSession.sessionId,
    config,
    log: logRef ?? undefined,
  });

  // Update session state with new high-water mark
  session.highWaterMark = result.newHighWaterMark;
  session.transcriptHash = result.newHash;

  // If compaction was detected (-1 delta lines), caller should handle refresh
  if (result.deltaLines === -1) {
    logRef?.warn(
      `acquirePreWarmedSessionWithSync: compaction detected for ${mainSessionKey}, session may need refresh`,
    );
  }

  return session;
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
    thinkingLevel: "none", // Voice sessions need no thinking for speed - latency is critical
    verboseLevel: mainSession?.verboseLevel,
  };

  store[ephemeralSessionKey] = ephemeralEntry;
  await saveSessionStore(storePath, store);

  // Copy context from main session and get line count
  let highWaterMark = 0;
  let transcriptHash = "";
  const agentId = resolveAgentIdFromSessionKey(mainSessionKey);
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

  // Pre-compact if transcript is large to avoid compaction latency during voice requests
  const precompactThreshold =
    openaiConfig.voiceCompactionThreshold ?? DEFAULT_PRECOMPACT_THRESHOLD;
  if (highWaterMark > precompactThreshold) {
    log?.info(
      `Pre-compacting voice session ${id}: ${highWaterMark} lines exceeds threshold ${precompactThreshold}`,
    );
    try {
      const workspaceDirRaw =
        config.agent?.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
      const workspace = await ensureAgentWorkspace({
        dir: workspaceDirRaw,
        ensureBootstrapFiles: !config.agent?.skipBootstrap,
      });
      const sessionFile = resolveSessionTranscriptPath(
        ephemeralSessionId,
        agentId,
      );
      const compactResult = await compactEmbeddedPiSession({
        sessionId: ephemeralSessionId,
        sessionKey: ephemeralSessionKey,
        sessionFile,
        workspaceDir: workspace.dir,
        config,
        model,
        thinkLevel: "off",
        lane: "voice-warmup",
      });
      if (compactResult.ok && compactResult.compacted) {
        // Re-read transcript to get new line count after compaction
        const content = await fs.promises
          .readFile(sessionFile, "utf-8")
          .catch(() => "");
        const newLineCount = content.split("\n").filter((l) => l.trim()).length;
        const newHash = computeTranscriptHash(content);
        log?.info(
          `Pre-compaction complete for ${id}: ${highWaterMark} -> ${newLineCount} lines`,
        );
        highWaterMark = newLineCount;
        transcriptHash = newHash;
      } else {
        log?.warn(
          `Pre-compaction skipped for ${id}: ${compactResult.reason ?? "not compacted"}`,
        );
      }
    } catch (err) {
      log?.warn(`Pre-compaction failed for ${id}: ${err}`);
      // Continue without compaction - voice request will trigger it if needed
    }
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
 * Check if a session key is a main session (eligible for pre-warming).
 * Main sessions match pattern agent:main:* and do NOT contain :voice:.
 */
export function isMainSessionKey(key: string): boolean {
  return key.startsWith("agent:main:") && !key.includes(":voice:");
}

/**
 * Run periodic warmup check.
 * - Discovers main sessions from the session store and creates pre-warmed sessions
 * - Refreshes sessions that are too old
 */
export async function runWarmupCheck(): Promise<void> {
  if (!getConfigRef || !logRef) return;

  const config = getConfigRef();
  const now = Date.now();

  // Load session store to discover main sessions
  const storePath = resolveStorePath(config.session?.store);
  const store = loadSessionStore(storePath);

  // Discover main sessions that need pre-warmed sessions
  for (const [key, entry] of Object.entries(store)) {
    // Only process main sessions (not voice sessions or other types)
    if (!isMainSessionKey(key)) continue;

    // Skip if no session ID (incomplete session)
    if (!entry.sessionId) continue;

    // Check if we already have a pre-warmed session for this main session
    const existing = preWarmedSessions.get(key);
    if (!existing) {
      // Also check session store for existing prewarm session (survives restarts)
      const prewarmKeyPrefix = `${key}:voice:prewarm-`;
      const existingInStore = Object.entries(store).find(
        ([k, _v]) => k.startsWith(prewarmKeyPrefix)
      );
      if (existingInStore) {
        // Load existing prewarm session into memory instead of creating new
        const [existingKey, existingEntry] = existingInStore;
        const prewarmId = existingKey.split(":voice:")[1]; // e.g., "prewarm-abc123"
        if (existingEntry.sessionId && prewarmId) {
          const loaded: PreWarmedSession = {
            id: prewarmId,
            mainSessionKey: key,
            ephemeralSessionKey: existingKey,
            ephemeralSessionId: existingEntry.sessionId,
            model: existingEntry.modelOverride ?? poolConfig.voiceModel ?? "claude-haiku-4-5",
            warmedAt: existingEntry.updatedAt ?? Date.now(),
            highWaterMark: 0,
            transcriptHash: "",
            inUse: false,
          };
          preWarmedSessions.set(key, loaded);
          logRef.info(`Loaded existing pre-warmed session ${prewarmId} from store for ${key}`);
          continue;
        }
      }
      logRef.info(`Creating pre-warmed session for main session: ${key}`);
      await createPreWarmedSession(key, config, logRef);
    }
  }

  // Check existing pre-warmed sessions for staleness
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

      // Remove the used session from in-memory map
      preWarmedSessions.delete(mainKey);

      // Also remove from session store to prevent stale session accumulation
      if (getConfigRef) {
        const config = getConfigRef();
        const storePath = resolveStorePath(config.session?.store);
        const store = loadSessionStore(storePath);
        if (store[session.ephemeralSessionKey]) {
          delete store[session.ephemeralSessionKey];
          await saveSessionStore(storePath, store);
          logRef?.info(
            `Deleted stale session ${session.ephemeralSessionKey} from store`,
          );
        }
      }

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
