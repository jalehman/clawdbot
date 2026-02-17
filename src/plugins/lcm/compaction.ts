import { createHash } from "node:crypto";
import type { ConversationStore, CreateMessagePartInput } from "./store/conversation-store.js";
import type { SummaryStore, SummaryRecord, ContextItemRecord } from "./store/summary-store.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface CompactionDecision {
  shouldCompact: boolean;
  reason: "threshold" | "manual" | "none";
  currentTokens: number;
  threshold: number;
}

export interface CompactionResult {
  actionTaken: boolean;
  /** Tokens before compaction */
  tokensBefore: number;
  /** Tokens after compaction */
  tokensAfter: number;
  /** Summary created (if any) */
  createdSummaryId?: string;
  /** Whether condensation was performed */
  condensed: boolean;
  /** Escalation level used: "normal" | "aggressive" | "fallback" */
  level?: CompactionLevel;
}

export interface CompactionConfig {
  /** Context threshold as fraction of budget (default 0.75) */
  contextThreshold: number;
  /** Number of fresh tail turns to protect (default 8) */
  freshTailCount: number;
  /** Max source tokens to compact per leaf/condensed chunk (default 20000) */
  leafChunkTokens?: number;
  /** Target tokens for leaf summaries (default 600) */
  leafTargetTokens: number;
  /** Target tokens for condensed summaries (default 900) */
  condensedTargetTokens: number;
  /** Maximum compaction rounds (default 10) */
  maxRounds: number;
}

type CompactionLevel = "normal" | "aggressive" | "fallback";
type CompactionPass = "leaf" | "condensed";
type CompactionSummarizeOptions = {
  previousSummary?: string;
  isCondensed?: boolean;
};
type CompactionSummarizeFn = (
  text: string,
  aggressive?: boolean,
  options?: CompactionSummarizeOptions,
) => Promise<string>;
type PassResult = { summaryId: string; level: CompactionLevel };
type LeafChunkSelection = {
  items: ContextItemRecord[];
  rawTokensOutsideTail: number;
  threshold: number;
};
type CondensedChunkSelection = {
  items: ContextItemRecord[];
  summaryTokens: number;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Estimate token count from character length (~4 chars per token). */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

/** Generate a deterministic summary ID from content + timestamp. */
function generateSummaryId(content: string): string {
  return (
    "sum_" +
    createHash("sha256")
      .update(content + Date.now().toString())
      .digest("hex")
      .slice(0, 16)
  );
}

/** Maximum characters for the deterministic fallback truncation (512 tokens * 4 chars). */
const FALLBACK_MAX_CHARS = 512 * 4;
const DEFAULT_LEAF_CHUNK_TOKENS = 20_000;
const CONDENSED_CHUNK_MAX_ITEMS = 17;
const CONDENSED_MIN_INPUT_RATIO = 0.1;

// ── CompactionEngine ─────────────────────────────────────────────────────────

export class CompactionEngine {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
    private config: CompactionConfig,
  ) {}

  // ── evaluate ─────────────────────────────────────────────────────────────

  /** Evaluate whether compaction is needed. */
  async evaluate(
    conversationId: number,
    tokenBudget: number,
    observedTokenCount?: number,
  ): Promise<CompactionDecision> {
    const storedTokens = await this.summaryStore.getContextTokenCount(conversationId);
    const liveTokens =
      typeof observedTokenCount === "number" &&
      Number.isFinite(observedTokenCount) &&
      observedTokenCount > 0
        ? Math.floor(observedTokenCount)
        : 0;
    const currentTokens = Math.max(storedTokens, liveTokens);
    const threshold = Math.floor(this.config.contextThreshold * tokenBudget);

    if (currentTokens > threshold) {
      return {
        shouldCompact: true,
        reason: "threshold",
        currentTokens,
        threshold,
      };
    }

    return {
      shouldCompact: false,
      reason: "none",
      currentTokens,
      threshold,
    };
  }

  /**
   * Evaluate whether the raw-message leaf trigger is active.
   *
   * Counts message tokens outside the protected fresh tail and compares against
   * `leafChunkTokens`. This lets callers trigger a soft incremental leaf pass
   * before the full context threshold is breached.
   */
  async evaluateLeafTrigger(conversationId: number): Promise<{
    shouldCompact: boolean;
    rawTokensOutsideTail: number;
    threshold: number;
  }> {
    const rawTokensOutsideTail = await this.countRawTokensOutsideFreshTail(conversationId);
    const threshold = this.resolveLeafChunkTokens();
    return {
      shouldCompact: rawTokensOutsideTail >= threshold,
      rawTokensOutsideTail,
      threshold,
    };
  }

  // ── compact ──────────────────────────────────────────────────────────────

  /** Run a full compaction sweep for a conversation. */
  async compact(input: {
    conversationId: number;
    tokenBudget: number;
    /** LLM call function for summarization */
    summarize: CompactionSummarizeFn;
    force?: boolean;
  }): Promise<CompactionResult> {
    return this.compactFullSweep(input);
  }

  /**
   * Run a single leaf pass against the oldest compactable raw chunk.
   *
   * This is the soft-trigger path used for incremental maintenance.
   */
  async compactLeaf(input: {
    conversationId: number;
    tokenBudget: number;
    summarize: CompactionSummarizeFn;
    force?: boolean;
    previousSummaryContent?: string;
  }): Promise<CompactionResult> {
    const { conversationId, tokenBudget, summarize, force } = input;

    const tokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
    const threshold = Math.floor(this.config.contextThreshold * tokenBudget);
    const leafTrigger = await this.evaluateLeafTrigger(conversationId);

    if (!force && tokensBefore <= threshold && !leafTrigger.shouldCompact) {
      return {
        actionTaken: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        condensed: false,
      };
    }

    const leafChunk = await this.selectOldestLeafChunk(conversationId);
    if (leafChunk.items.length === 0) {
      return {
        actionTaken: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        condensed: false,
      };
    }

    const leafResult = await this.leafPass(
      conversationId,
      leafChunk.items,
      summarize,
      input.previousSummaryContent,
    );
    const tokensAfter = await this.summaryStore.getContextTokenCount(conversationId);

    await this.persistCompactionEvents({
      conversationId,
      tokensBefore,
      tokensAfterLeaf: tokensAfter,
      tokensAfterFinal: tokensAfter,
      leafResult: { summaryId: leafResult.summaryId, level: leafResult.level },
      condenseResult: null,
    });

    return {
      actionTaken: true,
      tokensBefore,
      tokensAfter,
      createdSummaryId: leafResult.summaryId,
      condensed: false,
      level: leafResult.level,
    };
  }

  /**
   * Run a hard-trigger sweep:
   *
   * Phase 1: repeatedly compact raw-message chunks outside the fresh tail.
   * Phase 2: repeatedly condense oldest summary chunks while chunk utilization
   *          remains high enough to be worthwhile.
   */
  async compactFullSweep(input: {
    conversationId: number;
    tokenBudget: number;
    summarize: CompactionSummarizeFn;
    force?: boolean;
  }): Promise<CompactionResult> {
    const { conversationId, tokenBudget, summarize, force } = input;

    const tokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
    const threshold = Math.floor(this.config.contextThreshold * tokenBudget);
    const leafTrigger = await this.evaluateLeafTrigger(conversationId);

    if (!force && tokensBefore <= threshold && !leafTrigger.shouldCompact) {
      return {
        actionTaken: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        condensed: false,
      };
    }

    const contextItems = await this.summaryStore.getContextItems(conversationId);
    if (contextItems.length === 0) {
      return {
        actionTaken: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        condensed: false,
      };
    }

    let actionTaken = false;
    let condensed = false;
    let createdSummaryId: string | undefined;
    let level: CompactionLevel | undefined;
    let previousSummaryContent: string | undefined;
    let previousTokens = tokensBefore;

    // Phase 1: leaf passes over oldest raw chunks outside the protected tail.
    while (true) {
      const leafChunk = await this.selectOldestLeafChunk(conversationId);
      if (leafChunk.items.length === 0) {
        break;
      }

      const passTokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
      const leafResult = await this.leafPass(
        conversationId,
        leafChunk.items,
        summarize,
        previousSummaryContent,
      );
      const passTokensAfter = await this.summaryStore.getContextTokenCount(conversationId);
      await this.persistCompactionEvents({
        conversationId,
        tokensBefore: passTokensBefore,
        tokensAfterLeaf: passTokensAfter,
        tokensAfterFinal: passTokensAfter,
        leafResult: { summaryId: leafResult.summaryId, level: leafResult.level },
        condenseResult: null,
      });

      actionTaken = true;
      createdSummaryId = leafResult.summaryId;
      level = leafResult.level;
      previousSummaryContent = leafResult.content;

      if (passTokensAfter >= passTokensBefore || passTokensAfter >= previousTokens) {
        break;
      }
      previousTokens = passTokensAfter;
    }

    // Phase 2: condensed passes over ratio-sized summary chunks.
    while (true) {
      const condensedChunk = await this.selectOldestCondensedChunk(conversationId);
      if (condensedChunk.items.length < 2) {
        break;
      }
      if (condensedChunk.summaryTokens < this.resolveCondensedMinChunkTokens()) {
        break;
      }

      const passTokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
      const condenseResult = await this.condensedPass(
        conversationId,
        condensedChunk.items,
        summarize,
      );
      const passTokensAfter = await this.summaryStore.getContextTokenCount(conversationId);
      await this.persistCompactionEvents({
        conversationId,
        tokensBefore: passTokensBefore,
        tokensAfterLeaf: passTokensBefore,
        tokensAfterFinal: passTokensAfter,
        leafResult: null,
        condenseResult,
      });

      actionTaken = true;
      condensed = true;
      createdSummaryId = condenseResult.summaryId;
      level = condenseResult.level;

      if (passTokensAfter >= passTokensBefore || passTokensAfter >= previousTokens) {
        break;
      }
      previousTokens = passTokensAfter;
    }

    const tokensAfter = await this.summaryStore.getContextTokenCount(conversationId);

    return {
      actionTaken,
      tokensBefore,
      tokensAfter,
      createdSummaryId,
      condensed,
      level,
    };
  }

  // ── compactUntilUnder ────────────────────────────────────────────────────

  /** Compact until under the requested target, running up to maxRounds. */
  async compactUntilUnder(input: {
    conversationId: number;
    tokenBudget: number;
    targetTokens?: number;
    currentTokens?: number;
    summarize: CompactionSummarizeFn;
  }): Promise<{ success: boolean; rounds: number; finalTokens: number }> {
    const { conversationId, tokenBudget, summarize } = input;
    const targetTokens =
      typeof input.targetTokens === "number" &&
      Number.isFinite(input.targetTokens) &&
      input.targetTokens > 0
        ? Math.floor(input.targetTokens)
        : tokenBudget;

    const storedTokens = await this.summaryStore.getContextTokenCount(conversationId);
    const liveTokens =
      typeof input.currentTokens === "number" &&
      Number.isFinite(input.currentTokens) &&
      input.currentTokens > 0
        ? Math.floor(input.currentTokens)
        : 0;
    let lastTokens = Math.max(storedTokens, liveTokens);

    // For forced overflow recovery, callers may pass an observed count that
    // equals the context budget. Treat equality as still needing a compaction
    // attempt so we can create headroom for provider-side framing overhead.
    if (lastTokens < targetTokens) {
      return { success: true, rounds: 0, finalTokens: lastTokens };
    }

    for (let round = 1; round <= this.config.maxRounds; round++) {
      const result = await this.compact({
        conversationId,
        tokenBudget,
        summarize,
        force: true,
      });

      if (result.tokensAfter <= targetTokens) {
        return {
          success: true,
          rounds: round,
          finalTokens: result.tokensAfter,
        };
      }

      // No progress -- bail to avoid infinite loop
      if (!result.actionTaken || result.tokensAfter >= lastTokens) {
        return {
          success: false,
          rounds: round,
          finalTokens: result.tokensAfter,
        };
      }

      lastTokens = result.tokensAfter;
    }

    // Exhausted all rounds
    const finalTokens = await this.summaryStore.getContextTokenCount(conversationId);
    return {
      success: finalTokens <= targetTokens,
      rounds: this.config.maxRounds,
      finalTokens,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Normalize configured leaf chunk size to a safe positive integer. */
  private resolveLeafChunkTokens(): number {
    if (
      typeof this.config.leafChunkTokens === "number" &&
      Number.isFinite(this.config.leafChunkTokens) &&
      this.config.leafChunkTokens > 0
    ) {
      return Math.floor(this.config.leafChunkTokens);
    }
    return DEFAULT_LEAF_CHUNK_TOKENS;
  }

  /** Normalize configured fresh tail count to a safe non-negative integer. */
  private resolveFreshTailCount(): number {
    if (
      typeof this.config.freshTailCount === "number" &&
      Number.isFinite(this.config.freshTailCount) &&
      this.config.freshTailCount > 0
    ) {
      return Math.floor(this.config.freshTailCount);
    }
    return 0;
  }

  /**
   * Compute the ordinal boundary for protected fresh messages.
   *
   * Messages with ordinal >= returned value are preserved as fresh tail.
   */
  private resolveFreshTailOrdinal(contextItems: ContextItemRecord[]): number {
    const freshTailCount = this.resolveFreshTailCount();
    if (freshTailCount <= 0) {
      return Infinity;
    }

    const rawMessageItems = contextItems.filter(
      (item) => item.itemType === "message" && item.messageId != null,
    );
    if (rawMessageItems.length === 0) {
      return Infinity;
    }

    const tailStartIdx = Math.max(0, rawMessageItems.length - freshTailCount);
    return rawMessageItems[tailStartIdx]?.ordinal ?? Infinity;
  }

  /** Resolve message token count with a content-length fallback. */
  private async getMessageTokenCount(messageId: number): Promise<number> {
    const message = await this.conversationStore.getMessageById(messageId);
    if (!message) {
      return 0;
    }
    if (
      typeof message.tokenCount === "number" &&
      Number.isFinite(message.tokenCount) &&
      message.tokenCount > 0
    ) {
      return message.tokenCount;
    }
    return estimateTokens(message.content);
  }

  /** Sum raw message tokens outside the protected fresh tail. */
  private async countRawTokensOutsideFreshTail(conversationId: number): Promise<number> {
    const contextItems = await this.summaryStore.getContextItems(conversationId);
    const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
    let rawTokens = 0;

    for (const item of contextItems) {
      if (item.ordinal >= freshTailOrdinal) {
        break;
      }
      if (item.itemType !== "message" || item.messageId == null) {
        continue;
      }
      rawTokens += await this.getMessageTokenCount(item.messageId);
    }

    return rawTokens;
  }

  /**
   * Select the oldest contiguous raw-message chunk outside fresh tail.
   *
   * The selected chunk size is capped by `leafChunkTokens`, but we always pick
   * at least one message when any compactable message exists.
   */
  private async selectOldestLeafChunk(conversationId: number): Promise<LeafChunkSelection> {
    const contextItems = await this.summaryStore.getContextItems(conversationId);
    const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
    const threshold = this.resolveLeafChunkTokens();

    let rawTokensOutsideTail = 0;
    for (const item of contextItems) {
      if (item.ordinal >= freshTailOrdinal) {
        break;
      }
      if (item.itemType !== "message" || item.messageId == null) {
        continue;
      }
      rawTokensOutsideTail += await this.getMessageTokenCount(item.messageId);
    }

    const chunk: ContextItemRecord[] = [];
    let chunkTokens = 0;
    let started = false;
    for (const item of contextItems) {
      if (item.ordinal >= freshTailOrdinal) {
        break;
      }

      if (!started) {
        if (item.itemType !== "message" || item.messageId == null) {
          continue;
        }
        started = true;
      } else if (item.itemType !== "message" || item.messageId == null) {
        break;
      }

      if (item.messageId == null) {
        continue;
      }
      const messageTokens = await this.getMessageTokenCount(item.messageId);
      if (chunk.length > 0 && chunkTokens + messageTokens > threshold) {
        break;
      }

      chunk.push(item);
      chunkTokens += messageTokens;
      if (chunkTokens >= threshold) {
        break;
      }
    }

    return { items: chunk, rawTokensOutsideTail, threshold };
  }

  /** Resolve summary token count with content-length fallback. */
  private resolveSummaryTokenCount(summary: SummaryRecord): number {
    if (
      typeof summary.tokenCount === "number" &&
      Number.isFinite(summary.tokenCount) &&
      summary.tokenCount > 0
    ) {
      return summary.tokenCount;
    }
    return estimateTokens(summary.content);
  }

  /** Minimum condensed input size before we run another condensed pass. */
  private resolveCondensedMinChunkTokens(): number {
    const chunkTarget = this.resolveLeafChunkTokens();
    const ratioFloor = Math.floor(chunkTarget * CONDENSED_MIN_INPUT_RATIO);
    return Math.max(this.config.condensedTargetTokens, ratioFloor);
  }

  /**
   * Select the oldest contiguous summary chunk for condensed compaction.
   *
   * The chunk is bounded by both item count (~17) and summary-token budget
   * (`leafChunkTokens`) to keep each pass ratio-stable.
   */
  private async selectOldestCondensedChunk(
    conversationId: number,
  ): Promise<CondensedChunkSelection> {
    const contextItems = await this.summaryStore.getContextItems(conversationId);
    const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
    const chunkTokenBudget = this.resolveLeafChunkTokens();

    const chunk: ContextItemRecord[] = [];
    let summaryTokens = 0;
    let started = false;
    for (const item of contextItems) {
      if (item.ordinal >= freshTailOrdinal) {
        break;
      }

      if (!started) {
        if (item.itemType !== "summary" || item.summaryId == null) {
          continue;
        }
        started = true;
      } else if (item.itemType !== "summary" || item.summaryId == null) {
        break;
      }

      if (item.summaryId == null) {
        continue;
      }
      const summary = await this.summaryStore.getSummary(item.summaryId);
      if (!summary) {
        if (chunk.length > 0) {
          break;
        }
        continue;
      }
      const tokenCount = this.resolveSummaryTokenCount(summary);

      if (chunk.length >= CONDENSED_CHUNK_MAX_ITEMS) {
        break;
      }
      if (chunk.length > 0 && summaryTokens + tokenCount > chunkTokenBudget) {
        break;
      }

      chunk.push(item);
      summaryTokens += tokenCount;
      if (chunk.length >= CONDENSED_CHUNK_MAX_ITEMS || summaryTokens >= chunkTokenBudget) {
        break;
      }
    }

    return { items: chunk, summaryTokens };
  }

  /**
   * Run three-level summarization escalation:
   * normal -> aggressive -> deterministic fallback.
   */
  private async summarizeWithEscalation(params: {
    sourceText: string;
    summarize: CompactionSummarizeFn;
    options?: CompactionSummarizeOptions;
  }): Promise<{ content: string; level: CompactionLevel }> {
    const sourceText = params.sourceText.trim();
    if (!sourceText) {
      return {
        content: "[Truncated from 0 tokens]",
        level: "fallback",
      };
    }
    const inputTokens = Math.max(1, estimateTokens(sourceText));

    let summaryText = await params.summarize(sourceText, false, params.options);
    let level: CompactionLevel = "normal";

    if (estimateTokens(summaryText) >= inputTokens) {
      summaryText = await params.summarize(sourceText, true, params.options);
      level = "aggressive";

      if (estimateTokens(summaryText) >= inputTokens) {
        const truncated =
          sourceText.length > FALLBACK_MAX_CHARS
            ? sourceText.slice(0, FALLBACK_MAX_CHARS)
            : sourceText;
        summaryText = `${truncated}\n[Truncated from ${inputTokens} tokens]`;
        level = "fallback";
      }
    }

    return { content: summaryText, level };
  }

  // ── Private: Leaf Pass ───────────────────────────────────────────────────

  /**
   * Summarize a chunk of messages into one leaf summary.
   */
  private async leafPass(
    conversationId: number,
    messageItems: ContextItemRecord[],
    summarize: CompactionSummarizeFn,
    previousSummaryContent?: string,
  ): Promise<{ summaryId: string; level: CompactionLevel; content: string }> {
    // Fetch full message content for each context item
    const messageContents: { messageId: number; content: string }[] = [];
    for (const item of messageItems) {
      if (item.messageId == null) {
        continue;
      }
      const msg = await this.conversationStore.getMessageById(item.messageId);
      if (msg) {
        messageContents.push({
          messageId: msg.messageId,
          content: msg.content,
        });
      }
    }

    const concatenated = messageContents.map((m) => m.content).join("\n\n");
    const summary = await this.summarizeWithEscalation({
      sourceText: concatenated,
      summarize,
      options: {
        previousSummary: previousSummaryContent,
        isCondensed: false,
      },
    });

    // Persist the leaf summary
    const summaryId = generateSummaryId(summary.content);
    const tokenCount = estimateTokens(summary.content);

    await this.summaryStore.insertSummary({
      summaryId,
      conversationId,
      kind: "leaf",
      content: summary.content,
      tokenCount,
    });

    // Link to source messages
    const messageIds = messageContents.map((m) => m.messageId);
    await this.summaryStore.linkSummaryToMessages(summaryId, messageIds);

    // Replace the message range in context with the new summary
    const ordinals = messageItems.map((ci) => ci.ordinal);
    const startOrdinal = Math.min(...ordinals);
    const endOrdinal = Math.max(...ordinals);

    await this.summaryStore.replaceContextRangeWithSummary({
      conversationId,
      startOrdinal,
      endOrdinal,
      summaryId,
    });

    return { summaryId, level: summary.level, content: summary.content };
  }

  // ── Private: Condensed Pass ──────────────────────────────────────────────

  /**
   * Condense one ratio-sized summary chunk into a single condensed summary.
   */
  private async condensedPass(
    conversationId: number,
    summaryItems: ContextItemRecord[],
    summarize: CompactionSummarizeFn,
  ): Promise<PassResult> {
    // Fetch full summary records
    const summaryRecords: SummaryRecord[] = [];
    for (const item of summaryItems) {
      if (item.summaryId == null) {
        continue;
      }
      const rec = await this.summaryStore.getSummary(item.summaryId);
      if (rec) {
        summaryRecords.push(rec);
      }
    }

    const concatenated = summaryRecords.map((s) => s.content).join("\n\n");
    const condensed = await this.summarizeWithEscalation({
      sourceText: concatenated,
      summarize,
      options: {
        isCondensed: true,
      },
    });

    // Persist the condensed summary
    const summaryId = generateSummaryId(condensed.content);
    const tokenCount = estimateTokens(condensed.content);

    await this.summaryStore.insertSummary({
      summaryId,
      conversationId,
      kind: "condensed",
      content: condensed.content,
      tokenCount,
    });

    // Link to parent summaries
    const parentSummaryIds = summaryRecords.map((s) => s.summaryId);
    await this.summaryStore.linkSummaryToParents(summaryId, parentSummaryIds);

    // Replace all summary items in context with the condensed summary
    const ordinals = summaryItems.map((ci) => ci.ordinal);
    const startOrdinal = Math.min(...ordinals);
    const endOrdinal = Math.max(...ordinals);

    await this.summaryStore.replaceContextRangeWithSummary({
      conversationId,
      startOrdinal,
      endOrdinal,
      summaryId,
    });

    return { summaryId, level: condensed.level };
  }

  /**
   * Persist durable compaction events into canonical history as message parts.
   *
   * Event persistence is best-effort: failures are swallowed to avoid
   * compromising the core compaction path.
   */
  private async persistCompactionEvents(input: {
    conversationId: number;
    tokensBefore: number;
    tokensAfterLeaf: number;
    tokensAfterFinal: number;
    leafResult: { summaryId: string; level: CompactionLevel } | null;
    condenseResult: { summaryId: string; level: CompactionLevel } | null;
  }): Promise<void> {
    const {
      conversationId,
      tokensBefore,
      tokensAfterLeaf,
      tokensAfterFinal,
      leafResult,
      condenseResult,
    } = input;

    if (!leafResult && !condenseResult) {
      return;
    }

    const conversation = await this.conversationStore.getConversation(conversationId);
    if (!conversation) {
      return;
    }

    const createdSummaryIds = [leafResult?.summaryId, condenseResult?.summaryId].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    const condensedPassOccurred = condenseResult !== null;

    if (leafResult) {
      await this.persistCompactionEvent({
        conversationId,
        sessionId: conversation.sessionId,
        pass: "leaf",
        level: leafResult.level,
        tokensBefore,
        tokensAfter: tokensAfterLeaf,
        createdSummaryId: leafResult.summaryId,
        createdSummaryIds,
        condensedPassOccurred,
      });
    }

    if (condenseResult) {
      await this.persistCompactionEvent({
        conversationId,
        sessionId: conversation.sessionId,
        pass: "condensed",
        level: condenseResult.level,
        tokensBefore: tokensAfterLeaf,
        tokensAfter: tokensAfterFinal,
        createdSummaryId: condenseResult.summaryId,
        createdSummaryIds,
        condensedPassOccurred,
      });
    }
  }

  /** Write one compaction event message + part atomically where possible. */
  private async persistCompactionEvent(input: {
    conversationId: number;
    sessionId: string;
    pass: CompactionPass;
    level: CompactionLevel;
    tokensBefore: number;
    tokensAfter: number;
    createdSummaryId: string;
    createdSummaryIds: string[];
    condensedPassOccurred: boolean;
  }): Promise<void> {
    const content = `LCM compaction ${input.pass} pass (${input.level}): ${input.tokensBefore} -> ${input.tokensAfter}`;
    const metadata = JSON.stringify({
      conversationId: input.conversationId,
      pass: input.pass,
      level: input.level,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter,
      createdSummaryId: input.createdSummaryId,
      createdSummaryIds: input.createdSummaryIds,
      condensedPassOccurred: input.condensedPassOccurred,
    });

    const writeEvent = async (): Promise<void> => {
      const seq = (await this.conversationStore.getMaxSeq(input.conversationId)) + 1;
      const eventMessage = await this.conversationStore.createMessage({
        conversationId: input.conversationId,
        seq,
        role: "system",
        content,
        tokenCount: estimateTokens(content),
      });

      const parts: CreateMessagePartInput[] = [
        {
          sessionId: input.sessionId,
          partType: "compaction",
          ordinal: 0,
          textContent: content,
          metadata,
        },
      ];
      await this.conversationStore.createMessageParts(eventMessage.messageId, parts);
    };

    try {
      await this.conversationStore.withTransaction(() => writeEvent());
    } catch {
      // Compaction should still succeed if event persistence fails.
    }
  }
}
