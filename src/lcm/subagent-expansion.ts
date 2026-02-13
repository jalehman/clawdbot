import type { RetrievalEngine, RetrievalExpandInput } from "./types.js";

const DEFAULT_DIRECT_DEPTH_THRESHOLD = 2;
const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 8;
const DEFAULT_TOKEN_CAP = 4_000;
const MAX_TOKEN_CAP = 20_000;
const DEFAULT_PASS_DEPTH = 3;
const DEFAULT_PASS_TOKEN_CAP = 4_000;
const MAX_PASSES = 12;
const DIRECT_SYNTHESIS_CHAR_LIMIT = 240;
const DIRECT_EXPAND_LIMIT = 160;
const BROAD_QUERY_PATTERN =
  /\b(timeline|history|range|between|across|month|quarter|year|multi[- ]hop)\b/i;

/**
 * Parsed structure expected from a subagent expansion pass.
 */
export type ParsedExpansionResult = {
  synthesis: string;
  citedIds: string[];
  nextSummaryIds: string[];
};

/**
 * Subagent runner input for one iterative deep-expansion pass.
 */
export type SubagentExpansionRunRequest = {
  prompt: string;
  targetIds: string[];
  conversationIds: string[];
  question: string;
  tokenCap: number;
  depth: number;
  passIndex: number;
};

/**
 * Callable interface used to execute one subagent pass.
 */
export type SubagentExpansionRunner = (request: SubagentExpansionRunRequest) => Promise<string>;

/**
 * Strategy used for expansion orchestration.
 */
export type ExpansionStrategy = "direct" | "subagent";

/**
 * Request shape accepted by the orchestrator.
 */
export type ExpandDeepRequest = {
  targetIds: string[];
  question: string;
  sessionKey?: string;
  depth?: number;
  tokenCap?: number;
  includeMessages?: boolean;
  maxPasses?: number;
  strategy?: "auto" | ExpansionStrategy;
};

/**
 * Per-pass diagnostics emitted by deep expansion.
 */
export type ExpandDeepPassResult = {
  passIndex: number;
  strategy: ExpansionStrategy;
  targetIds: string[];
  depth: number;
  tokenCap: number;
  synthesis: string;
  citedIds: string[];
  nextSummaryIds: string[];
};

/**
 * Final deep-expansion output returned to callers.
 */
export type ExpandDeepResult = {
  strategy: ExpansionStrategy;
  synthesis: string;
  citedIds: string[];
  nextSummaryIds: string[];
  truncated: boolean;
  passCount: number;
  depthUsed: number;
  tokenBudgetUsed: number;
  warnings: string[];
  passes: ExpandDeepPassResult[];
};

/**
 * Configuration for the subagent expansion orchestrator.
 */
export type SubagentExpansionOrchestratorOptions = {
  retrieval: RetrievalEngine;
  runSubagent?: SubagentExpansionRunner;
  directDepthThreshold?: number;
  passDepth?: number;
  passTokenCap?: number;
};

/**
 * Build a deterministic expansion task prompt for a subagent pass.
 */
export function buildExpansionPrompt(
  targetIds: string[],
  question: string,
  tokenCap: number,
  depth: number,
) {
  const normalizedTargets = normalizeIds(targetIds);
  const normalizedQuestion = question.trim();
  const safeDepth = clampInt(depth, DEFAULT_DEPTH, 0, MAX_DEPTH);
  const safeTokenCap = clampInt(tokenCap, DEFAULT_TOKEN_CAP, 1, MAX_TOKEN_CAP);
  return [
    "You are running a focused LCM deep-expansion pass.",
    "",
    `Question: ${normalizedQuestion || "Summarize key findings for follow-up."}`,
    `Target summary IDs: ${normalizedTargets.join(", ") || "(none)"}`,
    `Traversal depth limit: ${safeDepth}`,
    `Token budget limit: ${safeTokenCap}`,
    "",
    "Rules:",
    "1. Use lcm_expand only with summary ids.",
    "2. If you encounter file ids, use lcm_describe first and then file readers if needed.",
    "3. Traverse recursively within the provided depth and budget bounds.",
    "4. Keep findings concise and cite exact IDs for follow-up.",
    "",
    "Return JSON only with this shape:",
    '{"synthesis":"...","citedIds":["sum-..."],"nextSummaryIds":["sum-..."]}',
  ].join("\n");
}

/**
 * Parse subagent output into synthesis + cited ids + follow-up summary ids.
 */
export function parseExpansionResult(subagentOutput: string): ParsedExpansionResult {
  const trimmed = subagentOutput.trim();
  if (!trimmed) {
    return { synthesis: "", citedIds: [], nextSummaryIds: [] };
  }

  const jsonCandidate = extractJsonCandidate(trimmed);
  if (jsonCandidate && typeof jsonCandidate === "object" && !Array.isArray(jsonCandidate)) {
    const record = jsonCandidate as Record<string, unknown>;
    const synthesis = readFirstString(record, ["synthesis", "summary", "answer"]) ?? "";
    const citedIds = normalizeIds(
      readFirstStringArray(record, ["citedIds", "cited_ids", "citations", "cited"]),
    );
    const nextSummaryIds = normalizeIds(
      readFirstStringArray(record, ["nextSummaryIds", "next_summary_ids", "nextIds", "next"]),
    );
    if (synthesis || citedIds.length > 0 || nextSummaryIds.length > 0) {
      return { synthesis, citedIds, nextSummaryIds };
    }
  }

  const synthesis = trimmed;
  const citedIds = extractFallbackIds(trimmed, /cited ids?|citations?/i);
  const nextSummaryIds = extractFallbackIds(trimmed, /next (summary )?ids?/i);
  return { synthesis, citedIds, nextSummaryIds };
}

/**
 * Coordinates direct and subagent-driven multi-pass deep expansion.
 */
export class SubagentExpansionOrchestrator {
  private readonly retrieval: RetrievalEngine;
  private readonly runSubagent?: SubagentExpansionRunner;
  private readonly directDepthThreshold: number;
  private readonly passDepth: number;
  private readonly passTokenCap: number;

  /**
   * Construct the orchestrator with retrieval + optional subagent execution.
   */
  constructor(options: SubagentExpansionOrchestratorOptions) {
    this.retrieval = options.retrieval;
    this.runSubagent = options.runSubagent;
    this.directDepthThreshold = clampInt(
      options.directDepthThreshold,
      DEFAULT_DIRECT_DEPTH_THRESHOLD,
      0,
      MAX_DEPTH,
    );
    this.passDepth = clampInt(options.passDepth, DEFAULT_PASS_DEPTH, 1, MAX_DEPTH);
    this.passTokenCap = clampInt(options.passTokenCap, DEFAULT_PASS_TOKEN_CAP, 1, MAX_TOKEN_CAP);
  }

  /**
   * Execute deep expansion with deterministic policy and bounded traversal.
   */
  async expandDeep(request: ExpandDeepRequest): Promise<ExpandDeepResult> {
    const targetIds = normalizeIds(request.targetIds);
    if (targetIds.length === 0) {
      throw new Error("targetIds must include at least one summary id.");
    }

    const question = request.question.trim();
    const depth = clampInt(request.depth, DEFAULT_DEPTH, 0, MAX_DEPTH);
    const tokenCap = clampInt(request.tokenCap, DEFAULT_TOKEN_CAP, 1, MAX_TOKEN_CAP);
    if (depth === 0) {
      return {
        strategy: "direct",
        synthesis: "",
        citedIds: targetIds,
        nextSummaryIds: targetIds,
        truncated: true,
        passCount: 0,
        depthUsed: 0,
        tokenBudgetUsed: 0,
        warnings: ["Depth=0 prevents traversal."],
        passes: [],
      };
    }

    const strategy = this.resolveStrategy({
      requested: request.strategy,
      depth,
      tokenCap,
      targetCount: targetIds.length,
      question,
    });

    if (strategy === "direct") {
      return await this.expandDirect({
        targetIds,
        depth,
        tokenCap,
        includeMessages: request.includeMessages ?? false,
        sessionKey: request.sessionKey,
      });
    }

    return await this.expandWithSubagent({
      targetIds,
      question,
      depth,
      tokenCap,
      sessionKey: request.sessionKey,
      maxPasses: clampInt(
        request.maxPasses,
        Math.max(1, Math.ceil(depth / this.passDepth)),
        1,
        MAX_PASSES,
      ),
    });
  }

  /**
   * Decide whether direct or subagent expansion is appropriate for this request.
   */
  private resolveStrategy(input: {
    requested?: "auto" | ExpansionStrategy;
    depth: number;
    tokenCap: number;
    targetCount: number;
    question: string;
  }): ExpansionStrategy {
    if (input.requested === "direct") {
      return "direct";
    }
    if (input.requested === "subagent") {
      return this.runSubagent ? "subagent" : "direct";
    }
    if (!this.runSubagent) {
      return "direct";
    }
    if (input.depth <= this.directDepthThreshold) {
      return "direct";
    }
    if (input.targetCount >= 3) {
      return "subagent";
    }
    if (input.tokenCap > this.passTokenCap) {
      return "subagent";
    }
    if (BROAD_QUERY_PATTERN.test(input.question)) {
      return "subagent";
    }
    return "direct";
  }

  /**
   * Perform bounded direct retrieval.expand calls without subagent spawning.
   */
  private async expandDirect(params: {
    targetIds: string[];
    depth: number;
    tokenCap: number;
    includeMessages: boolean;
    sessionKey?: string;
  }): Promise<ExpandDeepResult> {
    const perTargetTokenCap = Math.max(1, Math.floor(params.tokenCap / params.targetIds.length));
    const citedIds = new Set<string>();
    const nextSummaryIds = new Set<string>();
    const synthesisParts: string[] = [];
    const passResults: ExpandDeepPassResult[] = [];
    let tokenBudgetUsed = 0;
    let truncated = false;

    for (const summaryId of params.targetIds) {
      citedIds.add(summaryId);
      const expandInput: RetrievalExpandInput = {
        summaryId: summaryId as RetrievalExpandInput["summaryId"],
        depth: params.depth,
        includeMessages: params.includeMessages,
        tokenCap: perTargetTokenCap,
        limit: DIRECT_EXPAND_LIMIT,
        auth: {
          sessionKey: params.sessionKey,
        },
      };
      const expanded = await this.retrieval.expand(expandInput);
      tokenBudgetUsed += expanded.estimatedTokens;
      truncated = truncated || expanded.truncated;
      for (const summary of expanded.summaries) {
        citedIds.add(summary.id);
      }
      for (const id of expanded.nextSummaryIds) {
        citedIds.add(id);
        nextSummaryIds.add(id);
      }
      const summaryText =
        expanded.summaries
          .slice(0, 2)
          .map((entry) => entry.body.trim())
          .filter(Boolean)
          .join(" ") || "No child summaries returned.";
      synthesisParts.push(`${summaryId}: ${clip(summaryText, DIRECT_SYNTHESIS_CHAR_LIMIT)}`);
      passResults.push({
        passIndex: passResults.length + 1,
        strategy: "direct",
        targetIds: [summaryId],
        depth: params.depth,
        tokenCap: perTargetTokenCap,
        synthesis: clip(summaryText, DIRECT_SYNTHESIS_CHAR_LIMIT),
        citedIds: normalizeIds([summaryId, ...expanded.summaries.map((item) => item.id)]),
        nextSummaryIds: normalizeIds(expanded.nextSummaryIds),
      });
    }

    return {
      strategy: "direct",
      synthesis: synthesisParts.join("\n"),
      citedIds: normalizeIds([...citedIds]),
      nextSummaryIds: normalizeIds([...nextSummaryIds]),
      truncated,
      passCount: passResults.length,
      depthUsed: params.depth,
      tokenBudgetUsed: Math.min(params.tokenCap, Math.max(0, tokenBudgetUsed)),
      warnings: [],
      passes: passResults,
    };
  }

  /**
   * Run multi-pass subagent expansion with deterministic depth/token budgeting.
   */
  private async expandWithSubagent(params: {
    targetIds: string[];
    question: string;
    depth: number;
    tokenCap: number;
    sessionKey?: string;
    maxPasses: number;
  }): Promise<ExpandDeepResult> {
    if (!this.runSubagent) {
      const direct = await this.expandDirect({
        ...params,
        includeMessages: false,
      });
      return {
        ...direct,
        warnings: [
          ...direct.warnings,
          "Subagent runner unavailable; fell back to direct expansion.",
        ],
      };
    }

    const seen = new Set<string>(params.targetIds);
    const citedIds = new Set<string>(params.targetIds);
    const warnings: string[] = [];
    const passResults: ExpandDeepPassResult[] = [];
    const synthesisParts: string[] = [];
    const allowedConversationIds = await this.resolveTargetConversationIds({
      targetIds: params.targetIds,
      sessionKey: params.sessionKey,
    });
    const allowedConversationIdSet = new Set<string>(allowedConversationIds);

    let pendingTargetIds = [...params.targetIds];
    let remainingDepth = params.depth;
    let remainingTokenCap = params.tokenCap;

    while (
      pendingTargetIds.length > 0 &&
      remainingDepth > 0 &&
      remainingTokenCap > 0 &&
      passResults.length < params.maxPasses
    ) {
      const passIndex = passResults.length + 1;
      const passDepth = Math.min(this.passDepth, remainingDepth);
      const passTokenCap = Math.min(this.passTokenCap, remainingTokenCap);
      const prompt = buildExpansionPrompt(
        pendingTargetIds,
        params.question,
        passTokenCap,
        passDepth,
      );

      let parsed: ParsedExpansionResult;
      try {
        const output = await this.runSubagent({
          prompt,
          targetIds: pendingTargetIds,
          conversationIds: allowedConversationIds,
          question: params.question,
          tokenCap: passTokenCap,
          depth: passDepth,
          passIndex,
        });
        parsed = parseExpansionResult(output);
      } catch (error) {
        warnings.push(
          `Subagent pass ${passIndex} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        break;
      }

      const synthesis = parsed.synthesis.trim() || `No synthesis returned for pass ${passIndex}.`;
      synthesisParts.push(synthesis);

      for (const citedId of parsed.citedIds) {
        citedIds.add(citedId);
      }
      for (const targetId of pendingTargetIds) {
        citedIds.add(targetId);
      }

      const nextSummaryIds = normalizeIds(parsed.nextSummaryIds.filter((id) => !seen.has(id)));
      const scopedNextSummaryIds = await this.filterTargetIdsByConversationScope({
        targetIds: nextSummaryIds,
        allowedConversationIdSet,
        sessionKey: params.sessionKey,
        passIndex,
        warnings,
      });
      for (const id of scopedNextSummaryIds) {
        seen.add(id);
      }

      passResults.push({
        passIndex,
        strategy: "subagent",
        targetIds: pendingTargetIds,
        depth: passDepth,
        tokenCap: passTokenCap,
        synthesis,
        citedIds: normalizeIds([...parsed.citedIds, ...pendingTargetIds]),
        nextSummaryIds: scopedNextSummaryIds,
      });

      pendingTargetIds = scopedNextSummaryIds;
      remainingDepth -= passDepth;
      remainingTokenCap -= passTokenCap;
    }

    if (passResults.length === 0) {
      const fallback = await this.expandDirect({
        targetIds: params.targetIds,
        depth: Math.min(params.depth, this.directDepthThreshold),
        tokenCap: params.tokenCap,
        includeMessages: false,
        sessionKey: params.sessionKey,
      });
      return {
        ...fallback,
        warnings: [...warnings, "Subagent passes produced no usable output; used direct fallback."],
      };
    }

    const truncated = pendingTargetIds.length > 0;
    const tokenBudgetUsed = Math.max(0, params.tokenCap - remainingTokenCap);
    const depthUsed = Math.max(0, params.depth - remainingDepth);

    return {
      strategy: "subagent",
      synthesis: synthesisParts.join("\n\n"),
      citedIds: normalizeIds([...citedIds]),
      nextSummaryIds: pendingTargetIds,
      truncated,
      passCount: passResults.length,
      depthUsed,
      tokenBudgetUsed,
      warnings,
      passes: passResults,
    };
  }

  /**
   * Resolve conversation ids for summary targets and require valid summary ids.
   */
  private async resolveTargetConversationIds(params: {
    targetIds: string[];
    sessionKey?: string;
  }): Promise<string[]> {
    const conversationIds = new Set<string>();
    for (const targetId of params.targetIds) {
      const described = await this.retrieval.describe(targetId, {
        sessionKey: params.sessionKey,
      });
      if (!described || described.kind !== "summary") {
        throw new Error(`summary '${targetId}' was not found.`);
      }
      conversationIds.add(described.conversationId);
    }
    return normalizeIds([...conversationIds]);
  }

  /**
   * Keep only follow-up ids that stay inside delegated conversation scope.
   */
  private async filterTargetIdsByConversationScope(params: {
    targetIds: string[];
    allowedConversationIdSet: Set<string>;
    sessionKey?: string;
    passIndex: number;
    warnings: string[];
  }): Promise<string[]> {
    const scoped: string[] = [];
    for (const targetId of params.targetIds) {
      try {
        const described = await this.retrieval.describe(targetId, {
          sessionKey: params.sessionKey,
        });
        if (!described || described.kind !== "summary") {
          params.warnings.push(
            `Ignored follow-up summary id '${targetId}' from pass ${params.passIndex}; id not found.`,
          );
          continue;
        }
        if (!params.allowedConversationIdSet.has(described.conversationId)) {
          params.warnings.push(
            `Ignored out-of-scope summary id '${targetId}' from pass ${params.passIndex}.`,
          );
          continue;
        }
        scoped.push(targetId);
      } catch (error) {
        params.warnings.push(
          `Ignored follow-up summary id '${targetId}' from pass ${params.passIndex}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return normalizeIds(scoped);
  }
}

function normalizeIds(ids: string[] | undefined): string[] {
  if (!Array.isArray(ids)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of ids) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  return Math.min(max, Math.max(min, normalized));
}

function clip(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function extractJsonCandidate(output: string): unknown {
  const direct = parseJsonMaybe(output);
  if (direct !== undefined) {
    return direct;
  }
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!fenced?.[1]) {
    return undefined;
  }
  return parseJsonMaybe(fenced[1]);
}

function parseJsonMaybe(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readFirstStringArray(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function extractFallbackIds(text: string, heading: RegExp): string[] {
  const lines = text.split(/\r?\n/);
  const collected: string[] = [];
  let inSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (inSection) {
        break;
      }
      continue;
    }
    if (heading.test(line)) {
      inSection = true;
      const sameLineIds = line
        .split(":")
        .slice(1)
        .join(":")
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      collected.push(...sameLineIds);
      continue;
    }
    if (!inSection) {
      continue;
    }
    if (!line.startsWith("-") && !line.startsWith("*")) {
      break;
    }
    const value = line.slice(1).trim();
    if (value) {
      collected.push(value);
    }
  }
  return normalizeIds(collected);
}
