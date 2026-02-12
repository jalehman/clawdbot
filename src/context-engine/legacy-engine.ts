import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import type { TranscriptPolicy } from "../agents/transcript-policy.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  ContextAssembleParams,
  ContextAssembleResult,
  ContextCompactParams,
  ContextCompactResult,
  ContextEngine,
  ContextIngestParams,
  ContextIngestResult,
} from "./types.js";
import { validateAnthropicTurns, validateGeminiTurns } from "../agents/pi-embedded-helpers.js";
import { sanitizeSessionHistory } from "../agents/pi-embedded-runner/google.js";
import {
  getDmHistoryLimitFromSessionKey,
  limitHistoryTurns,
} from "../agents/pi-embedded-runner/history.js";
import { describeUnknownError } from "../agents/pi-embedded-runner/utils.js";
import { sanitizeToolUseResultPairing } from "../agents/session-transcript-repair.js";
import { resolveTranscriptPolicy } from "../agents/transcript-policy.js";
import {
  DEFAULT_CONTEXT_ENGINE_ID,
  registeredContextEngineIds,
  registerContextEngine,
} from "./registry.js";

/**
 * Minimal shape returned by the embedded Pi session compaction call.
 */
export type LegacySessionCompactResult = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
};

/**
 * Minimal session shape needed to run the legacy compaction logic.
 */
export type LegacyCompactSession = {
  messages: AgentMessage[];
  compact(customInstructions?: string): Promise<LegacySessionCompactResult>;
};

/**
 * Legacy adapter metadata threaded through the neutral context-engine contract.
 * c3a.2 callsites can pass the existing runtime dependencies here unchanged.
 */
export type LegacyContextEngineMeta = {
  modelApi?: string | null;
  provider?: string;
  modelId?: string;
  sessionId?: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  sessionManager?: SessionManager;
  transcriptPolicy?: TranscriptPolicy;
  compactSession?: LegacyCompactSession;
};

function resolveLegacyMeta(meta?: Record<string, unknown>): LegacyContextEngineMeta | undefined {
  return meta as LegacyContextEngineMeta | undefined;
}

function resolvePolicy(meta?: LegacyContextEngineMeta): TranscriptPolicy | undefined {
  if (!meta) {
    return undefined;
  }
  if (meta.transcriptPolicy) {
    return meta.transcriptPolicy;
  }
  if (!meta.modelApi && !meta.provider && !meta.modelId) {
    return undefined;
  }
  return resolveTranscriptPolicy({
    modelApi: meta.modelApi,
    provider: meta.provider,
    modelId: meta.modelId,
  });
}

/**
 * Default context engine that reproduces the current inline runner behavior.
 */
export class LegacyContextEngine implements ContextEngine {
  readonly id = DEFAULT_CONTEXT_ENGINE_ID;

  /**
   * Legacy ingest path: transcript sanitation/repair from sanitizeSessionHistory().
   */
  async ingest(params: ContextIngestParams): Promise<ContextIngestResult> {
    const meta = resolveLegacyMeta(params.meta);
    if (!meta?.sessionManager) {
      return { messages: params.messages, meta: params.meta };
    }
    const messages = await sanitizeSessionHistory({
      messages: params.messages,
      modelApi: meta.modelApi,
      modelId: params.modelId,
      provider: params.provider,
      sessionManager: meta.sessionManager,
      sessionId: params.sessionId,
      policy: resolvePolicy(meta),
    });
    return { messages, meta: params.meta };
  }

  /**
   * Legacy assemble path: validate turns, apply DM truncation, then repair tool pairing.
   */
  async assemble(params: ContextAssembleParams): Promise<ContextAssembleResult> {
    const meta = resolveLegacyMeta(params.meta);
    const policy = resolvePolicy(meta);
    const validatedGemini = policy?.validateGeminiTurns
      ? validateGeminiTurns(params.messages)
      : params.messages;
    const validated = policy?.validateAnthropicTurns
      ? validateAnthropicTurns(validatedGemini)
      : validatedGemini;
    const historyTurnLimit =
      params.historyTurnLimit ?? getDmHistoryLimitFromSessionKey(meta?.sessionKey, meta?.config);
    const truncated = limitHistoryTurns(validated, historyTurnLimit);
    const messages = policy?.repairToolUseResultPairing
      ? sanitizeToolUseResultPairing(truncated)
      : truncated;
    return { messages, meta: params.meta };
  }

  /**
   * Legacy compact path: call session.compact() and shape the result exactly as today.
   */
  async compact(params: ContextCompactParams): Promise<ContextCompactResult> {
    const meta = resolveLegacyMeta(params.meta);
    const compactSession = meta?.compactSession;
    if (!compactSession) {
      return {
        ok: false,
        compacted: false,
        reason: "Legacy context engine compact() requires meta.compactSession.",
      };
    }
    try {
      const result = await compactSession.compact(params.customInstructions);
      let tokensAfter: number | undefined;
      try {
        tokensAfter = 0;
        for (const message of compactSession.messages) {
          tokensAfter += estimateTokens(message);
        }
        if (tokensAfter > result.tokensBefore) {
          tokensAfter = undefined;
        }
      } catch {
        tokensAfter = undefined;
      }
      return {
        ok: true,
        compacted: true,
        result: {
          summary: result.summary,
          firstKeptEntryId: result.firstKeptEntryId,
          tokensBefore: result.tokensBefore,
          tokensAfter,
          details: result.details,
        },
      };
    } catch (error) {
      return {
        ok: false,
        compacted: false,
        reason: describeUnknownError(error),
      };
    }
  }
}

/**
 * Register the legacy context engine under the default "legacy" id.
 */
export function registerLegacyContextEngine(): void {
  if (registeredContextEngineIds().includes(DEFAULT_CONTEXT_ENGINE_ID)) {
    return;
  }
  registerContextEngine(DEFAULT_CONTEXT_ENGINE_ID, () => new LegacyContextEngine());
}

registerLegacyContextEngine();
