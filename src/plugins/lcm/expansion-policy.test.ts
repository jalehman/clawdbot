import { describe, expect, it } from "vitest";
import {
  EXPANSION_ROUTING_THRESHOLDS,
  classifyExpansionTokenRisk,
  decideLcmExpansionRouting,
  detectBroadTimeRangeIndicator,
  detectMultiHopIndicator,
  estimateExpansionTokens,
} from "./expansion-policy.js";

describe("decideLcmExpansionRouting", () => {
  it("answers directly when no candidate summaries are available", () => {
    const decision = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "recent auth failures",
      candidateSummaryCount: 0,
      requestedMaxDepth: 3,
      tokenCap: 1200,
    });

    expect(decision.action).toBe("answer_directly");
    expect(decision.triggers.directByNoCandidates).toBe(true);
  });

  it("answers directly for low-complexity query probes", () => {
    const decision = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "failed login",
      candidateSummaryCount: 1,
      requestedMaxDepth: 2,
      tokenCap: 10_000,
    });

    expect(decision.action).toBe("answer_directly");
    expect(decision.triggers.directByLowComplexityProbe).toBe(true);
  });

  it("uses shallow expansion for low-complexity explicit expand requests", () => {
    const decision = decideLcmExpansionRouting({
      intent: "explicit_expand",
      candidateSummaryCount: 1,
      requestedMaxDepth: 2,
      tokenCap: 10_000,
    });

    expect(decision.action).toBe("expand_shallow");
  });

  it("delegates exactly at the depth threshold boundary", () => {
    const below = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "auth chain",
      candidateSummaryCount: 2,
      requestedMaxDepth: EXPANSION_ROUTING_THRESHOLDS.delegateDepthThreshold - 1,
      tokenCap: 10_000,
    });
    const at = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "auth chain",
      candidateSummaryCount: 2,
      requestedMaxDepth: EXPANSION_ROUTING_THRESHOLDS.delegateDepthThreshold,
      tokenCap: 10_000,
    });

    expect(below.action).toBe("expand_shallow");
    expect(at.action).toBe("delegate_traversal");
    expect(at.triggers.delegateByDepth).toBe(true);
  });

  it("delegates exactly at the candidate-count threshold boundary", () => {
    const below = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "incident spread",
      candidateSummaryCount: EXPANSION_ROUTING_THRESHOLDS.delegateCandidateThreshold - 1,
      requestedMaxDepth: 2,
      tokenCap: 10_000,
    });
    const at = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "incident spread",
      candidateSummaryCount: EXPANSION_ROUTING_THRESHOLDS.delegateCandidateThreshold,
      requestedMaxDepth: 2,
      tokenCap: 10_000,
    });

    expect(below.action).toBe("expand_shallow");
    expect(at.action).toBe("delegate_traversal");
    expect(at.triggers.delegateByCandidateCount).toBe(true);
  });

  it("delegates when token risk crosses the high-risk boundary", () => {
    const estimateInput = {
      requestedMaxDepth: 3,
      candidateSummaryCount: 3,
      includeMessages: true,
      broadTimeRangeIndicator: false,
      multiHopIndicator: true,
    };
    const estimatedTokens = estimateExpansionTokens(estimateInput);
    const capJustBelowHighRisk = Math.max(
      1,
      Math.ceil(estimatedTokens / EXPANSION_ROUTING_THRESHOLDS.highTokenRiskRatio) - 1,
    );
    const capAtOrAboveHighRisk = Math.ceil(
      estimatedTokens / EXPANSION_ROUTING_THRESHOLDS.highTokenRiskRatio,
    );

    const below = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "root cause chain",
      candidateSummaryCount: estimateInput.candidateSummaryCount,
      requestedMaxDepth: estimateInput.requestedMaxDepth,
      includeMessages: true,
      tokenCap: capAtOrAboveHighRisk,
    });
    const at = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "root cause chain",
      candidateSummaryCount: estimateInput.candidateSummaryCount,
      requestedMaxDepth: estimateInput.requestedMaxDepth,
      includeMessages: true,
      tokenCap: capJustBelowHighRisk,
    });

    expect(below.action).toBe("expand_shallow");
    expect(at.action).toBe("delegate_traversal");
    expect(at.triggers.delegateByTokenRisk).toBe(true);
  });

  it("delegates for combined broad time-range and multi-hop indicators", () => {
    const decision = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "build timeline from 2021 to 2025 and explain root cause chain",
      candidateSummaryCount: 2,
      requestedMaxDepth: 2,
      tokenCap: 10_000,
    });

    expect(decision.action).toBe("delegate_traversal");
    expect(decision.triggers.delegateByBroadTimeRangeAndMultiHop).toBe(true);
  });
});

describe("expansion-policy indicators", () => {
  it("detects broad time-range year windows of at least two years", () => {
    expect(detectBroadTimeRangeIndicator("events from 2022 to 2024")).toBe(true);
    expect(detectBroadTimeRangeIndicator("events from 2024 to 2025")).toBe(false);
  });

  it("detects multi-hop from traversal depth and query language", () => {
    expect(
      detectMultiHopIndicator({
        query: "normal summary lookup",
        requestedMaxDepth: EXPANSION_ROUTING_THRESHOLDS.multiHopDepthThreshold,
        candidateSummaryCount: 1,
      }),
    ).toBe(true);
    expect(
      detectMultiHopIndicator({
        query: "explain the chain of events",
        requestedMaxDepth: 1,
        candidateSummaryCount: 1,
      }),
    ).toBe(true);
  });

  it("classifies token risk at exact ratio boundaries", () => {
    const moderate = classifyExpansionTokenRisk({
      estimatedTokens: 35,
      tokenCap: 100,
    });
    const high = classifyExpansionTokenRisk({
      estimatedTokens: 70,
      tokenCap: 100,
    });

    expect(moderate.level).toBe("moderate");
    expect(high.level).toBe("high");
    expect(moderate.ratio).toBeCloseTo(EXPANSION_ROUTING_THRESHOLDS.moderateTokenRiskRatio, 8);
    expect(high.ratio).toBeCloseTo(EXPANSION_ROUTING_THRESHOLDS.highTokenRiskRatio, 8);
  });
});
