import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ContextCompactResult } from "../../context-engine/types.js";
import type { TranscriptPolicy } from "../transcript-policy.js";
import {
  LegacyContextEngine,
  type LegacySessionCompactResult,
} from "../../context-engine/index.js";
import { validateAnthropicTurns, validateGeminiTurns } from "../pi-embedded-helpers.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import { compactSessionWithContextEngine } from "./compact.js";
import { sanitizeSessionHistory } from "./google.js";
import { limitHistoryTurns } from "./history.js";
import { assembleSessionHistoryWithContextEngine } from "./run/attempt.js";

function policy(overrides: Partial<TranscriptPolicy> = {}): TranscriptPolicy {
  return {
    sanitizeMode: "images-only",
    sanitizeToolCallIds: false,
    repairToolUseResultPairing: false,
    preserveSignatures: false,
    normalizeAntigravityThinkingBlocks: false,
    applyGoogleTurnOrdering: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
    allowSyntheticToolResults: false,
    ...overrides,
  };
}

function mockSessionManager(): SessionManager {
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  return {
    getEntries: vi.fn(() => entries),
    appendCustomEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
  } as unknown as SessionManager;
}

async function assembleWithInlineLegacyPath(params: {
  messages: AgentMessage[];
  provider: string;
  modelId: string;
  modelApi: string;
  sessionId: string;
  sessionManager: SessionManager;
  transcriptPolicy: TranscriptPolicy;
  historyTurnLimit: number;
}): Promise<AgentMessage[]> {
  const prior = await sanitizeSessionHistory({
    messages: params.messages,
    modelApi: params.modelApi,
    modelId: params.modelId,
    provider: params.provider,
    sessionManager: params.sessionManager,
    sessionId: params.sessionId,
    policy: params.transcriptPolicy,
  });
  const validatedGemini = params.transcriptPolicy.validateGeminiTurns
    ? validateGeminiTurns(prior)
    : prior;
  const validated = params.transcriptPolicy.validateAnthropicTurns
    ? validateAnthropicTurns(validatedGemini)
    : validatedGemini;
  const truncated = limitHistoryTurns(validated, params.historyTurnLimit);
  return params.transcriptPolicy.repairToolUseResultPairing
    ? sanitizeToolUseResultPairing(truncated)
    : truncated;
}

async function compactWithInlineLegacyPath(params: {
  messages: AgentMessage[];
  provider: string;
  modelId: string;
  modelApi: string;
  sessionId: string;
  sessionManager: SessionManager;
  transcriptPolicy: TranscriptPolicy;
  historyTurnLimit: number;
  customInstructions?: string;
  compactSession: {
    messages: AgentMessage[];
    compact(customInstructions?: string): Promise<LegacySessionCompactResult>;
  };
}): Promise<ContextCompactResult> {
  const limited = await assembleWithInlineLegacyPath({
    messages: params.messages,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    sessionId: params.sessionId,
    sessionManager: params.sessionManager,
    transcriptPolicy: params.transcriptPolicy,
    historyTurnLimit: params.historyTurnLimit,
  });
  if (limited.length > 0) {
    params.compactSession.messages = limited;
  }

  const result = await params.compactSession.compact(params.customInstructions);
  let tokensAfter: number | undefined;
  try {
    tokensAfter = 0;
    for (const message of params.compactSession.messages) {
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
}

describe("LegacyContextEngine parity checkpoints", () => {
  it("matches inline assembly behavior in run attempt history preparation", async () => {
    const sessionManager = mockSessionManager();
    const transcriptPolicy = policy({ repairToolUseResultPairing: true });
    const messages: AgentMessage[] = [
      { role: "user", content: "older user turn" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      { role: "user", content: "middle user turn" },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "tool output seen" }] },
      { role: "user", content: "latest user turn" },
    ];

    const expected = await assembleWithInlineLegacyPath({
      messages,
      provider: "anthropic",
      modelId: "claude-sonnet",
      modelApi: "anthropic-messages",
      sessionId: "session-1",
      sessionManager,
      transcriptPolicy,
      historyTurnLimit: 2,
    });

    const result = await assembleSessionHistoryWithContextEngine({
      contextEngine: new LegacyContextEngine(),
      messages,
      provider: "anthropic",
      modelId: "claude-sonnet",
      sessionId: "session-1",
      historyTurnLimit: 2,
      ingestMeta: {
        modelApi: "anthropic-messages",
        sessionManager,
        transcriptPolicy,
      },
      assembleMeta: {
        sessionKey: "session-key",
      },
    });

    expect(result).toEqual(expected);
  });

  it("matches inline compaction shaping through compactSessionWithContextEngine", async () => {
    const sessionManager = mockSessionManager();
    const transcriptPolicy = policy({ repairToolUseResultPairing: true });
    const messages: AgentMessage[] = [
      { role: "user", content: "older user turn" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      { role: "user", content: "middle user turn" },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "tool output seen" }] },
      { role: "user", content: "latest user turn" },
    ];

    const createCompactSession = () => ({
      messages: [...messages],
      compact: vi.fn(async () => ({
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 10_000,
        details: { source: "test" },
      })),
    });

    const inlineCompactSession = createCompactSession();
    const expected = await compactWithInlineLegacyPath({
      messages,
      provider: "anthropic",
      modelId: "claude-sonnet",
      modelApi: "anthropic-messages",
      sessionId: "session-1",
      sessionManager,
      transcriptPolicy,
      historyTurnLimit: 2,
      customInstructions: "focus on decisions",
      compactSession: inlineCompactSession,
    });

    const engineCompactSession = createCompactSession();
    const replaceMessages = vi.fn((nextMessages: AgentMessage[]) => {
      engineCompactSession.messages = nextMessages;
    });

    const actual = await compactSessionWithContextEngine({
      contextEngine: new LegacyContextEngine(),
      messages,
      provider: "anthropic",
      modelId: "claude-sonnet",
      sessionId: "session-1",
      historyTurnLimit: 2,
      customInstructions: "focus on decisions",
      replaceMessages,
      ingestMeta: {
        modelApi: "anthropic-messages",
        sessionManager,
        transcriptPolicy,
      },
      assembleMeta: {
        sessionKey: "session-key",
      },
      compactMeta: {
        compactSession: engineCompactSession,
      },
    });

    expect(replaceMessages).toHaveBeenCalledTimes(1);
    expect(actual).toEqual(expected);
  });
});
