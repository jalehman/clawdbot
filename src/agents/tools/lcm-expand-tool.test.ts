import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LcmContextEngine } from "../../plugins/lcm/engine.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import {
  createDelegatedExpansionGrant,
  resetDelegatedExpansionGrantsForTests,
  revokeDelegatedExpansionGrantForSession,
} from "../../plugins/lcm/expansion-auth.js";
import { createLcmExpandTool } from "./lcm-expand-tool.js";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: vi.fn(),
}));

vi.mock("../../context-engine/registry.js", () => ({
  resolveContextEngine: vi.fn(),
}));

function makeMockRetrieval() {
  return {
    expand: vi.fn(),
    grep: vi.fn(),
  };
}

function makeEngine(mockRetrieval: ReturnType<typeof makeMockRetrieval>): LcmContextEngine {
  return {
    info: { id: "lcm" },
    getRetrieval: () => mockRetrieval,
  } as unknown as LcmContextEngine;
}

const ORIGINAL_MAX_EXPAND = process.env.LCM_MAX_EXPAND_TOKENS;

describe("createLcmExpandTool tokenCap bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callGatewayMock.mockReset();
    process.env.LCM_MAX_EXPAND_TOKENS = "120";
    resetDelegatedExpansionGrantsForTests();
  });

  afterEach(() => {
    resetDelegatedExpansionGrantsForTests();
    if (ORIGINAL_MAX_EXPAND === undefined) {
      delete process.env.LCM_MAX_EXPAND_TOKENS;
      return;
    }
    process.env.LCM_MAX_EXPAND_TOKENS = ORIGINAL_MAX_EXPAND;
  });

  it("defaults omitted tokenCap to configured max for summary expansion", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.expand.mockResolvedValue({
      children: [],
      messages: [],
      estimatedTokens: 40,
      truncated: false,
    });
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    const tool = createLcmExpandTool();
    await tool.execute("call-1", { summaryIds: ["sum_a"] });

    expect(ensureContextEnginesInitialized).toHaveBeenCalledTimes(1);
    expect(mockRetrieval.expand).toHaveBeenCalledWith(
      expect.objectContaining({
        summaryId: "sum_a",
        tokenCap: 120,
      }),
    );
  });

  it("clamps oversized tokenCap to configured max for query expansion", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [{ summaryId: "sum_match", conversationId: 7, kind: "leaf", snippet: "match" }],
      totalMatches: 1,
    });
    mockRetrieval.expand.mockResolvedValue({
      children: [],
      messages: [],
      estimatedTokens: 25,
      truncated: false,
    });
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    const tool = createLcmExpandTool();
    await tool.execute("call-2", {
      query: "auth",
      conversationId: 7,
      tokenCap: 9_999,
    });

    expect(mockRetrieval.expand).toHaveBeenCalledWith(
      expect.objectContaining({
        summaryId: "sum_match",
        tokenCap: 120,
      }),
    );
  });

  it("rejects delegated sub-agent expansion when no grant is propagated", async () => {
    const mockRetrieval = makeMockRetrieval();
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:no-grant" });
    const result = await tool.execute("call-missing-grant", { summaryIds: ["sum_a"] });

    expect(result.details).toMatchObject({
      error: expect.stringContaining("requires a valid grant"),
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
  });

  it("allows delegated sub-agent expansion with a valid grant", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.expand.mockResolvedValue({
      children: [],
      messages: [],
      estimatedTokens: 40,
      truncated: false,
    });
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:granted",
      issuerSessionId: "main",
      allowedConversationIds: [42],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:granted" });
    const result = await tool.execute("call-valid-grant", { summaryIds: ["sum_a"] });

    expect(mockRetrieval.expand).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({
      expansionCount: 1,
      totalTokens: 40,
      truncated: false,
    });
  });

  it("rejects delegated expansion with an expired grant", async () => {
    const mockRetrieval = makeMockRetrieval();
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:expired",
      issuerSessionId: "main",
      allowedConversationIds: [42],
      ttlMs: 0,
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:expired" });
    const result = await tool.execute("call-expired-grant", { summaryIds: ["sum_a"] });

    expect(result.details).toMatchObject({
      error: expect.stringMatching(/authorization failed.*expired/i),
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
  });

  it("rejects delegated expansion with a revoked grant", async () => {
    const mockRetrieval = makeMockRetrieval();
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:revoked",
      issuerSessionId: "main",
      allowedConversationIds: [42],
    });
    revokeDelegatedExpansionGrantForSession("agent:main:subagent:revoked");

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:revoked" });
    const result = await tool.execute("call-revoked-grant", { summaryIds: ["sum_a"] });

    expect(result.details).toMatchObject({
      error: expect.stringMatching(/authorization failed.*revoked/i),
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
  });

  it("rejects delegated expansion outside conversation scope", async () => {
    const mockRetrieval = makeMockRetrieval();
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:conversation-scope",
      issuerSessionId: "main",
      allowedConversationIds: [7],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:conversation-scope" });
    const result = await tool.execute("call-conv-scope", {
      summaryIds: ["sum_a"],
      conversationId: 8,
    });

    expect(result.details).toMatchObject({
      error: expect.stringContaining("Conversation 8"),
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
  });

  it("rejects delegated expansion over token cap", async () => {
    const mockRetrieval = makeMockRetrieval();
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:token-cap",
      issuerSessionId: "main",
      allowedConversationIds: [7],
      tokenCap: 50,
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:token-cap" });
    const result = await tool.execute("call-token-cap", {
      summaryIds: ["sum_a"],
      conversationId: 7,
      tokenCap: 120,
    });

    expect(result.details).toMatchObject({
      error: expect.stringMatching(/authorization failed.*token cap/i),
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
  });

  it("keeps route-only query probes local when there are no matches", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [],
      totalMatches: 0,
    });
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    const tool = createLcmExpandTool({ sessionId: "agent:main:main" });
    const result = await tool.execute("call-route-only", {
      query: "nothing to see",
      conversationId: 7,
      tokenCap: 120,
    });

    expect(mockRetrieval.expand).not.toHaveBeenCalled();
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      expansionCount: 0,
      executionPath: "direct",
      policy: {
        action: "answer_directly",
      },
    });
  });

  it("runs delegated expansion passes when routing selects delegation", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [
        { summaryId: "sum_1", conversationId: 7, kind: "leaf", snippet: "1" },
        { summaryId: "sum_2", conversationId: 7, kind: "leaf", snippet: "2" },
        { summaryId: "sum_3", conversationId: 7, kind: "leaf", snippet: "3" },
        { summaryId: "sum_4", conversationId: 7, kind: "leaf", snippet: "4" },
        { summaryId: "sum_5", conversationId: 7, kind: "leaf", snippet: "5" },
        { summaryId: "sum_6", conversationId: 7, kind: "leaf", snippet: "6" },
      ],
      totalMatches: 6,
    });
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    let agentRuns = 0;
    let historyReads = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        agentRuns += 1;
        return { runId: `run-${agentRuns}` };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        historyReads += 1;
        const firstPass =
          '{"summary":"first delegated pass","citedIds":["sum_1","sum_2"],"followUpSummaryIds":["sum_9"],"totalTokens":50,"truncated":false}';
        const secondPass =
          '{"summary":"second delegated pass","citedIds":["sum_9"],"followUpSummaryIds":[],"totalTokens":25,"truncated":false}';
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: historyReads === 1 ? firstPass : secondPass }],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:main" });
    const result = await tool.execute("call-delegated", {
      query: "deep chain",
      conversationId: 7,
      maxDepth: 6,
      tokenCap: 120,
    });

    expect(mockRetrieval.expand).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      executionPath: "delegated",
      citedIds: ["sum_1", "sum_2", "sum_9"],
      delegated: {
        status: "ok",
      },
    });
    const details = result.details as {
      delegated?: { passes?: Array<unknown> };
    };
    expect(details.delegated?.passes).toHaveLength(2);

    const methods = callGatewayMock.mock.calls.map(
      ([opts]) => (opts as { method?: string }).method,
    );
    expect(methods.filter((method) => method === "agent")).toHaveLength(2);
    expect(methods.filter((method) => method === "agent.wait")).toHaveLength(2);
    expect(methods.filter((method) => method === "sessions.delete")).toHaveLength(2);
  });

  it("falls back to direct expansion when delegated wait times out", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [
        { summaryId: "sum_1", conversationId: 7, kind: "leaf", snippet: "1" },
        { summaryId: "sum_2", conversationId: 7, kind: "leaf", snippet: "2" },
        { summaryId: "sum_3", conversationId: 7, kind: "leaf", snippet: "3" },
        { summaryId: "sum_4", conversationId: 7, kind: "leaf", snippet: "4" },
        { summaryId: "sum_5", conversationId: 7, kind: "leaf", snippet: "5" },
        { summaryId: "sum_6", conversationId: 7, kind: "leaf", snippet: "6" },
      ],
      totalMatches: 6,
    });
    mockRetrieval.expand.mockResolvedValue({
      children: [],
      messages: [],
      estimatedTokens: 10,
      truncated: false,
    });
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-timeout" };
      }
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:main" });
    const result = await tool.execute("call-timeout-fallback", {
      query: "deep chain",
      conversationId: 7,
      tokenCap: 120,
    });

    expect(mockRetrieval.expand).toHaveBeenCalled();
    expect(result.details).toMatchObject({
      executionPath: "direct_fallback",
      delegated: {
        status: "timeout",
      },
    });
  });

  it("falls back to direct expansion when delegated pass errors", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [
        { summaryId: "sum_1", conversationId: 7, kind: "leaf", snippet: "1" },
        { summaryId: "sum_2", conversationId: 7, kind: "leaf", snippet: "2" },
        { summaryId: "sum_3", conversationId: 7, kind: "leaf", snippet: "3" },
        { summaryId: "sum_4", conversationId: 7, kind: "leaf", snippet: "4" },
        { summaryId: "sum_5", conversationId: 7, kind: "leaf", snippet: "5" },
        { summaryId: "sum_6", conversationId: 7, kind: "leaf", snippet: "6" },
      ],
      totalMatches: 6,
    });
    mockRetrieval.expand.mockResolvedValue({
      children: [],
      messages: [],
      estimatedTokens: 10,
      truncated: false,
    });
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-error" };
      }
      if (request.method === "agent.wait") {
        return { status: "error", error: "auth denied" };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:main" });
    const result = await tool.execute("call-error-fallback", {
      query: "deep chain",
      conversationId: 7,
      tokenCap: 120,
    });

    expect(mockRetrieval.expand).toHaveBeenCalled();
    expect(result.details).toMatchObject({
      executionPath: "direct_fallback",
      delegated: {
        status: "error",
        error: "auth denied",
      },
    });
  });
});
