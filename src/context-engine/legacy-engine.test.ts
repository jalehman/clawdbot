import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptPolicy } from "../agents/transcript-policy.js";
import { sanitizeSessionHistory } from "../agents/pi-embedded-runner/google.js";
import { limitHistoryTurns } from "../agents/pi-embedded-runner/history.js";
import { sanitizeToolUseResultPairing } from "../agents/session-transcript-repair.js";
import { registerLegacyContextEngine } from "./legacy-engine.js";
import {
  DEFAULT_CONTEXT_ENGINE_ID,
  clearContextEngineRegistry,
  registeredContextEngineIds,
  selectContextEngine,
} from "./registry.js";

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

describe("LegacyContextEngine", () => {
  beforeEach(() => {
    clearContextEngineRegistry();
    registerLegacyContextEngine();
  });

  it("registers as the default legacy engine", () => {
    expect(registeredContextEngineIds()).toContain(DEFAULT_CONTEXT_ENGINE_ID);
    const selected = selectContextEngine(undefined);
    expect(selected.engine.id).toBe(DEFAULT_CONTEXT_ENGINE_ID);
    expect(selected.fallback).toBe(false);
  });

  it("ingest matches sanitizeSessionHistory behavior", async () => {
    const sessionManager = mockSessionManager();
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const transcriptPolicy = policy({
      applyGoogleTurnOrdering: true,
      sanitizeMode: "full",
    });
    const expected = await sanitizeSessionHistory({
      messages,
      modelApi: "google-generative-ai",
      modelId: "gemini-2.0-flash",
      provider: "google",
      sessionManager,
      sessionId: "session-1",
      policy: transcriptPolicy,
    });
    const engine = selectContextEngine(DEFAULT_CONTEXT_ENGINE_ID).engine;
    const result = await engine.ingest({
      messages,
      provider: "google",
      modelId: "gemini-2.0-flash",
      sessionId: "session-1",
      meta: {
        modelApi: "google-generative-ai",
        sessionManager,
        transcriptPolicy,
      },
    });
    expect(result.messages.map((entry) => entry.role)).toEqual(expected.map((entry) => entry.role));
    expect(result.messages[0]).toMatchObject({
      role: "user",
      content: "(session bootstrap)",
    });
    expect(result.messages.slice(1)).toEqual(expected.slice(1));
  });

  it("assemble matches validation, truncation, and post-truncation pairing repair", async () => {
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
    const transcriptPolicy = policy({ repairToolUseResultPairing: true });
    const truncated = limitHistoryTurns(messages, 2);
    const expected = sanitizeToolUseResultPairing(truncated);
    const engine = selectContextEngine(DEFAULT_CONTEXT_ENGINE_ID).engine;
    const result = await engine.assemble({
      messages,
      historyTurnLimit: 2,
      meta: {
        transcriptPolicy,
      },
    });
    expect(result.messages).toEqual(expected);
    expect(result.messages.some((m) => m.role === "toolResult")).toBe(false);
  });

  it("compact matches result shaping and token-after estimation", async () => {
    const compactSession = {
      messages: [{ role: "user", content: "post-compact transcript" }] as AgentMessage[],
      compact: vi.fn(async () => ({
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 10_000,
        details: { kind: "legacy" },
      })),
    };
    const engine = selectContextEngine(DEFAULT_CONTEXT_ENGINE_ID).engine;
    const result = await engine.compact({
      messages: [],
      customInstructions: "include TODOs",
      meta: { compactSession },
    });
    expect(compactSession.compact).toHaveBeenCalledWith("include TODOs");
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.summary).toBe("summary");
    expect(result.result?.tokensBefore).toBe(10_000);
    expect(typeof result.result?.tokensAfter).toBe("number");
    expect((result.result?.tokensAfter ?? 0) <= 10_000).toBe(true);
  });

  it("compact returns a non-throwing failure when compaction throws", async () => {
    const compactSession = {
      messages: [] as AgentMessage[],
      compact: vi.fn(async () => {
        throw new Error("compact failed");
      }),
    };
    const engine = selectContextEngine(DEFAULT_CONTEXT_ENGINE_ID).engine;
    const result = await engine.compact({
      messages: [],
      meta: { compactSession },
    });
    expect(result).toEqual({
      ok: false,
      compacted: false,
      reason: "compact failed",
    });
  });
});
