import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LcmContextEngine } from "../plugins/lcm/engine.js";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: vi.fn(),
}));

vi.mock("../context-engine/registry.js", () => ({
  resolveContextEngine: vi.fn(),
}));

import "./test-helpers/fast-core-tools.js";
import { resolveContextEngine } from "../context-engine/registry.js";
import { createOpenClawTools } from "./openclaw-tools.js";

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

describe("openclaw-tools lcm delegated orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callGatewayMock.mockReset();
    process.env.LCM_MAX_EXPAND_TOKENS = "120";
  });

  it("keeps route-only probes local without spawning delegated runs", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [],
      totalMatches: 0,
    });
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        plugins: { slots: { contextEngine: "lcm" } },
      },
    }).find((candidate) => candidate.name === "lcm_expand");
    if (!tool) {
      throw new Error("missing lcm_expand tool");
    }

    const result = await tool.execute("call-route-only", {
      query: "nope",
      conversationId: 7,
      tokenCap: 120,
    });

    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      executionPath: "direct",
      policy: { action: "answer_directly" },
      expansionCount: 0,
      observability: {
        decisionPath: {
          policyAction: "answer_directly",
          executionPath: "direct",
        },
      },
    });
  });

  it("spawns delegated subagent pass when routing selects delegation", async () => {
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

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: '{"summary":"delegated summary","citedIds":["sum_1"],"followUpSummaryIds":[],"totalTokens":25,"truncated":false}',
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        plugins: { slots: { contextEngine: "lcm" } },
      },
    }).find((candidate) => candidate.name === "lcm_expand");
    if (!tool) {
      throw new Error("missing lcm_expand tool");
    }

    const result = await tool.execute("call-delegated", {
      query: "deep chain",
      conversationId: 7,
      maxDepth: 6,
      tokenCap: 120,
    });

    expect(mockRetrieval.expand).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      executionPath: "delegated",
      citedIds: ["sum_1"],
      delegated: { status: "ok" },
      observability: {
        decisionPath: {
          policyAction: "delegate_traversal",
          executionPath: "delegated",
        },
        delegatedRunRefs: [
          {
            pass: 1,
            status: "ok",
            runId: "run-1",
          },
        ],
      },
    });
    const methods = callGatewayMock.mock.calls.map(
      ([opts]) => (opts as { method?: string }).method,
    );
    expect(methods).toContain("agent");
    expect(methods).toContain("agent.wait");
    expect(methods).toContain("chat.history");
    expect(methods).toContain("sessions.delete");
  });

  it("falls back to direct expansion when delegated execution times out", async () => {
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

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        plugins: { slots: { contextEngine: "lcm" } },
      },
    }).find((candidate) => candidate.name === "lcm_expand");
    if (!tool) {
      throw new Error("missing lcm_expand tool");
    }

    const result = await tool.execute("call-timeout-fallback", {
      query: "deep chain",
      conversationId: 7,
      tokenCap: 120,
    });

    expect(result.details).toMatchObject({
      executionPath: "direct_fallback",
      delegated: { status: "timeout" },
      observability: {
        decisionPath: {
          policyAction: "delegate_traversal",
          executionPath: "direct_fallback",
        },
        delegatedRunRefs: [
          {
            pass: 1,
            status: "timeout",
            runId: "run-timeout",
          },
        ],
      },
    });
    expect(mockRetrieval.expand).toHaveBeenCalled();
  });
});
