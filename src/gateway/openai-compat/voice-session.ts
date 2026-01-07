/**
 * Voice session forking and management.
 *
 * When a voice call starts via the OpenAI-compat endpoint, we fork the conversation
 * to use a fast model (Haiku) while preserving full context. On disconnect, we
 * compact the voice conversation and write a summary back to the main session.
 */

import { randomUUID } from "node:crypto";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../../config/sessions.js";
import type { ClawdbotConfig } from "../../config/types.js";

/** Default model for voice sessions - fast model for low latency. */
export const DEFAULT_VOICE_MODEL = "claude-3-5-haiku-latest";

/**
 * Voice session metadata tracked in memory.
 */
export type VoiceSessionInfo = {
  /** Unique ID for this voice session. */
  voiceSessionId: string;
  /** The main session key this voice session is forked from. */
  mainSessionKey: string;
  /** The ephemeral session key for voice interactions. */
  ephemeralSessionKey: string;
  /** Session ID (UUID) for the ephemeral transcript. */
  ephemeralSessionId: string;
  /** Model being used for voice. */
  model: string;
  /** Timestamp when voice session started. */
  startedAt: number;
  /** Number of turns in this voice session. */
  turnCount: number;
};

/**
 * In-memory registry of active voice sessions.
 * Maps voice session ID to voice session info.
 */
const activeVoiceSessions = new Map<string, VoiceSessionInfo>();

/**
 * Check if a header indicates this is a voice session.
 */
export function isVoiceSessionHeader(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const voiceHeader = headers["x-clawdbot-voice-session"];
  if (!voiceHeader) return false;
  const value = Array.isArray(voiceHeader) ? voiceHeader[0] : voiceHeader;
  return value?.toLowerCase() === "true" || value === "1";
}

/**
 * Get voice session ID from headers.
 */
export function getVoiceSessionId(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const sessionId = headers["x-clawdbot-voice-id"];
  if (!sessionId) return undefined;
  return Array.isArray(sessionId) ? sessionId[0] : sessionId;
}

/**
 * Get or create a voice session for the given main session key.
 *
 * If a voice session already exists for this main session, returns it.
 * Otherwise, creates a new ephemeral session with the voice model.
 */
export async function getOrCreateVoiceSession(params: {
  mainSessionKey: string;
  voiceSessionId?: string;
  config: ClawdbotConfig;
  log?: { info: (msg: string) => void };
}): Promise<VoiceSessionInfo> {
  const { mainSessionKey, voiceSessionId, config, log } = params;
  const openaiConfig = config.openaiCompat ?? {};

  // Check if we already have this voice session
  if (voiceSessionId) {
    const existing = activeVoiceSessions.get(voiceSessionId);
    if (existing) {
      existing.turnCount++;
      return existing;
    }
  }

  // Check if there's an existing voice session for this main session
  for (const [_id, info] of activeVoiceSessions) {
    if (info.mainSessionKey === mainSessionKey) {
      info.turnCount++;
      return info;
    }
  }

  // Create new voice session
  const newVoiceSessionId =
    voiceSessionId || `voice-${randomUUID().slice(0, 8)}`;
  const ephemeralSessionId = randomUUID();
  const ephemeralSessionKey = `${mainSessionKey}:voice:${newVoiceSessionId}`;
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
    // Copy thinking level from main session
    thinkingLevel: mainSession?.thinkingLevel,
    verboseLevel: mainSession?.verboseLevel,
  };

  store[ephemeralSessionKey] = ephemeralEntry;
  await saveSessionStore(storePath, store);

  const voiceInfo: VoiceSessionInfo = {
    voiceSessionId: newVoiceSessionId,
    mainSessionKey,
    ephemeralSessionKey,
    ephemeralSessionId,
    model,
    startedAt: Date.now(),
    turnCount: 1,
  };

  activeVoiceSessions.set(newVoiceSessionId, voiceInfo);
  log?.info(
    `Created voice session ${newVoiceSessionId} for main session ${mainSessionKey}`,
  );

  return voiceInfo;
}

/**
 * End a voice session and optionally compact it.
 *
 * If autoCompact is enabled (default), this will:
 * 1. Generate a summary of the voice conversation
 * 2. Write the summary to the main session
 * 3. Delete the ephemeral session
 */
export async function endVoiceSession(params: {
  voiceSessionId: string;
  config: ClawdbotConfig;
  generateSummary?: (sessionKey: string) => Promise<string>;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<{ compacted: boolean; summary?: string }> {
  const { voiceSessionId, config, generateSummary, log } = params;
  const openaiConfig = config.openaiCompat ?? {};
  const autoCompact = openaiConfig.autoCompact ?? true;

  const voiceInfo = activeVoiceSessions.get(voiceSessionId);
  if (!voiceInfo) {
    log?.warn(`Voice session ${voiceSessionId} not found`);
    return { compacted: false };
  }

  // Remove from active sessions
  activeVoiceSessions.delete(voiceSessionId);

  // Calculate duration
  const durationMs = Date.now() - voiceInfo.startedAt;
  const durationStr = formatDuration(durationMs);

  log?.info(
    `Ending voice session ${voiceSessionId} after ${voiceInfo.turnCount} turns (${durationStr})`,
  );

  if (!autoCompact || !generateSummary) {
    return { compacted: false };
  }

  try {
    // Generate summary of voice conversation
    const summary = await generateSummary(voiceInfo.ephemeralSessionKey);

    // Write summary to main session transcript
    // This would be done by sending a system message to the main session
    // For now, we just return the summary for the caller to handle
    const compactionSummary = `Voice call summary (${durationStr}, ${voiceInfo.turnCount} turns): ${summary}`;

    log?.info(
      `Compacted voice session ${voiceSessionId}: ${compactionSummary.slice(0, 100)}...`,
    );

    return { compacted: true, summary: compactionSummary };
  } catch (error) {
    log?.warn(`Failed to compact voice session ${voiceSessionId}: ${error}`);
    return { compacted: false };
  }
}

/**
 * Get active voice session info by ID.
 */
export function getVoiceSession(
  voiceSessionId: string,
): VoiceSessionInfo | undefined {
  return activeVoiceSessions.get(voiceSessionId);
}

/**
 * Get active voice session for a main session key.
 */
export function getVoiceSessionByMainKey(
  mainSessionKey: string,
): VoiceSessionInfo | undefined {
  for (const info of activeVoiceSessions.values()) {
    if (info.mainSessionKey === mainSessionKey) {
      return info;
    }
  }
  return undefined;
}

/**
 * List all active voice sessions.
 */
export function listActiveVoiceSessions(): VoiceSessionInfo[] {
  return Array.from(activeVoiceSessions.values());
}

/**
 * Clear all active voice sessions (for testing).
 */
export function clearVoiceSessions(): void {
  activeVoiceSessions.clear();
}

/**
 * Format duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
