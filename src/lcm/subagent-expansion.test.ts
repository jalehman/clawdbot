import { describe, expect, it, vi } from "vitest";
import type {
  RetrievalDescribeResult,
  RetrievalEngine,
  RetrievalExpandInput,
  RetrievalExpandResult,
} from "./types.js";
import {
  buildExpansionPrompt,
  parseExpansionResult,
  SubagentExpansionOrchestrator,
} from "./subagent-expansion.js";

function createRetrievalEngine(params?: {
  describe?: (
    id: string,
    auth?: RetrievalExpandInput["auth"],
  ) => Promise<RetrievalDescribeResult | null>;
  expand?: (summaryId: string, depth: number, tokenCap: number) => Promise<RetrievalExpandResult>;
  onExpandInput?: (input: RetrievalExpandInput) => void;
}): RetrievalEngine {
  return {
    async describe(id, auth) {
      if (params?.describe) {
        return await params.describe(id, auth);
      }
      return {
        id: id as RetrievalExpandResult["rootSummaryId"],
        kind: "summary",
        conversationId: "conv-test" as RetrievalExpandResult["conversationId"],
        itemType: "summary",
        tokenEstimate: 1,
        createdAt: "2026-02-10T00:00:00.000Z",
        metadata: {},
        lineage: {
          parentIds: [],
          childIds: [],
        },
      };
    },
    async grep(input) {
      return {
        query: input.query,
        mode: input.mode ?? "regex",
        scope: input.scope ?? "both",
        matches: [],
        truncated: false,
        scannedCount: 0,
      };
    },
    async expand(input) {
      params?.onExpandInput?.(input);
      const summaryId = String(input.summaryId);
      const depth = input.depth ?? 0;
      const tokenCap = input.tokenCap ?? 1_000;
      if (params?.expand) {
        return await params.expand(summaryId, depth, tokenCap);
      }
      return {
        rootSummaryId: summaryId as RetrievalExpandResult["rootSummaryId"],
        conversationId: "conv-test" as RetrievalExpandResult["conversationId"],
        summaries: [],
        messages: [],
        estimatedTokens: 0,
        truncated: false,
        nextSummaryIds: [],
      };
    },
  };
}

describe("LCM subagent expansion prompt and parsing", () => {
  it("builds deterministic expansion prompts", () => {
    const prompt = buildExpansionPrompt(
      ["sum-root", "sum-child"],
      "Trace auth regressions",
      3000,
      4,
    );
    expect(prompt).toContain("Question: Trace auth regressions");
    expect(prompt).toContain("Target summary IDs: sum-root, sum-child");
    expect(prompt).toContain("Traversal depth limit: 4");
    expect(prompt).toContain("Token budget limit: 3000");
    expect(prompt).toContain('"synthesis":"..."');
  });

  it("parses JSON-first subagent output", () => {
    const parsed = parseExpansionResult(`\`\`\`json
{"synthesis":"Auth rollback happened after deploy.","citedIds":["sum-a","sum-a"],"nextSummaryIds":["sum-b"]}
\`\`\``);
    expect(parsed.synthesis).toBe("Auth rollback happened after deploy.");
    expect(parsed.citedIds).toEqual(["sum-a"]);
    expect(parsed.nextSummaryIds).toEqual(["sum-b"]);
  });

  it("parses fallback plain-text sections", () => {
    const parsed = parseExpansionResult(
      [
        "Deployment findings point to a migration mismatch.",
        "Cited IDs:",
        "- sum-100",
        "- sum-101",
        "Next Summary IDs:",
        "- sum-102",
      ].join("\n"),
    );
    expect(parsed.synthesis).toContain("migration mismatch");
    expect(parsed.citedIds).toEqual(["sum-100", "sum-101"]);
    expect(parsed.nextSummaryIds).toEqual(["sum-102"]);
  });
});

describe("SubagentExpansionOrchestrator", () => {
  it("prefers direct expansion for shallow depth", async () => {
    const runSubagent = vi.fn();
    const retrieval = createRetrievalEngine({
      async expand(summaryId) {
        return {
          rootSummaryId: summaryId as RetrievalExpandResult["rootSummaryId"],
          conversationId: "conv-test" as RetrievalExpandResult["conversationId"],
          summaries: [
            {
              id: "sum-leaf" as RetrievalExpandResult["summaries"][number]["id"],
              conversationId: "conv-test" as RetrievalExpandResult["conversationId"],
              body: "Auth retry logic was removed before deploy.",
              depth: 1,
              createdAt: "2026-02-10T00:00:00.000Z",
              tokenEstimate: 80,
            },
          ],
          messages: [],
          estimatedTokens: 80,
          truncated: false,
          nextSummaryIds: [],
        };
      },
    });
    const orchestrator = new SubagentExpansionOrchestrator({
      retrieval,
      runSubagent,
    });

    const result = await orchestrator.expandDeep({
      targetIds: ["sum-root"],
      question: "What broke authentication?",
      depth: 2,
      tokenCap: 2000,
    });

    expect(result.strategy).toBe("direct");
    expect(runSubagent).not.toHaveBeenCalled();
    expect(result.citedIds).toContain("sum-root");
    expect(result.citedIds).toContain("sum-leaf");
  });

  it("forwards session auth context into direct retrieval expansion", async () => {
    let expandInput: RetrievalExpandInput | undefined;
    const retrieval = createRetrievalEngine({
      onExpandInput(input) {
        expandInput = input;
      },
    });
    const orchestrator = new SubagentExpansionOrchestrator({ retrieval });

    await orchestrator.expandDeep({
      targetIds: ["sum-root"],
      question: "Trace auth rollout",
      sessionKey: "agent:main:subagent:direct",
      depth: 2,
      tokenCap: 2_000,
      strategy: "direct",
    });

    expect(expandInput?.auth?.sessionKey).toBe("agent:main:subagent:direct");
  });

  it("runs iterative subagent passes and follows next ids", async () => {
    const retrieval = createRetrievalEngine();
    const runSubagent = vi.fn().mockImplementation(async (request: { passIndex: number }) => {
      if (request.passIndex === 1) {
        return JSON.stringify({
          synthesis: "Pass 1: Found migration divergence.",
          citedIds: ["sum-a"],
          nextSummaryIds: ["sum-b"],
        });
      }
      return JSON.stringify({
        synthesis: "Pass 2: Confirmed retry policy mismatch.",
        citedIds: ["sum-b"],
        nextSummaryIds: [],
      });
    });
    const orchestrator = new SubagentExpansionOrchestrator({
      retrieval,
      runSubagent,
    });

    const result = await orchestrator.expandDeep({
      targetIds: ["sum-a"],
      question: "Trace full auth regression timeline",
      depth: 6,
      tokenCap: 8_000,
      strategy: "subagent",
    });

    expect(runSubagent).toHaveBeenCalledTimes(2);
    expect(runSubagent.mock.calls[1]?.[0].targetIds).toEqual(["sum-b"]);
    expect(result.strategy).toBe("subagent");
    expect(result.synthesis).toContain("Pass 1");
    expect(result.synthesis).toContain("Pass 2");
    expect(result.citedIds).toEqual(["sum-a", "sum-b"]);
  });

  it("passes delegated conversation scope to subagent runs", async () => {
    const retrieval = createRetrievalEngine({
      async describe(id) {
        if (id === "sum-a") {
          return {
            id: "sum-a" as RetrievalExpandResult["rootSummaryId"],
            kind: "summary",
            conversationId: "conv-alpha" as RetrievalExpandResult["conversationId"],
            itemType: "summary",
            tokenEstimate: 1,
            createdAt: "2026-02-10T00:00:00.000Z",
            metadata: {},
            lineage: { parentIds: [], childIds: [] },
          };
        }
        if (id === "sum-b") {
          return {
            id: "sum-b" as RetrievalExpandResult["rootSummaryId"],
            kind: "summary",
            conversationId: "conv-beta" as RetrievalExpandResult["conversationId"],
            itemType: "summary",
            tokenEstimate: 1,
            createdAt: "2026-02-10T00:00:00.000Z",
            metadata: {},
            lineage: { parentIds: [], childIds: [] },
          };
        }
        return null;
      },
    });
    const runSubagent = vi.fn().mockResolvedValue(
      JSON.stringify({
        synthesis: "Scoped pass complete.",
        citedIds: ["sum-a"],
        nextSummaryIds: [],
      }),
    );
    const orchestrator = new SubagentExpansionOrchestrator({
      retrieval,
      runSubagent,
    });

    await orchestrator.expandDeep({
      targetIds: ["sum-a", "sum-b"],
      question: "Cross-session test",
      depth: 6,
      tokenCap: 8_000,
      strategy: "subagent",
    });

    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(runSubagent.mock.calls[0]?.[0].conversationIds).toEqual(["conv-alpha", "conv-beta"]);
  });

  it("enforces depth and token bounds across iterative passes", async () => {
    const retrieval = createRetrievalEngine();
    const runSubagent = vi.fn().mockImplementation(async (request: { passIndex: number }) =>
      JSON.stringify({
        synthesis: `Pass ${request.passIndex}: additional findings.`,
        citedIds: [`sum-${request.passIndex}`],
        nextSummaryIds: [`sum-next-${request.passIndex}`],
      }),
    );
    const orchestrator = new SubagentExpansionOrchestrator({
      retrieval,
      runSubagent,
    });

    const result = await orchestrator.expandDeep({
      targetIds: ["sum-root"],
      question: "Investigate the full history",
      depth: 99,
      tokenCap: 99_999,
      maxPasses: 99,
      strategy: "subagent",
    });

    const depthPerPass = runSubagent.mock.calls.map((call) => call[0].depth);
    const tokenPerPass = runSubagent.mock.calls.map((call) => call[0].tokenCap);
    const totalDepth = depthPerPass.reduce((acc, value) => acc + value, 0);
    const totalToken = tokenPerPass.reduce((acc, value) => acc + value, 0);

    expect(depthPerPass.every((value) => value <= 3)).toBe(true);
    expect(tokenPerPass.every((value) => value <= 4_000)).toBe(true);
    expect(totalDepth).toBeLessThanOrEqual(8);
    expect(totalToken).toBeLessThanOrEqual(20_000);
    expect(result.depthUsed).toBe(totalDepth);
    expect(result.tokenBudgetUsed).toBe(totalToken);
    expect(result.truncated).toBe(true);
  });
});
