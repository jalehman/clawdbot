import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LcmContextEngine } from "../../plugins/lcm/engine.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import { createLcmExpandTool } from "./lcm-expand-tool.js";

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
    process.env.LCM_MAX_EXPAND_TOKENS = "120";
  });

  afterEach(() => {
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
});
