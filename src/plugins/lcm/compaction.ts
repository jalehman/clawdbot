import { createHash } from "node:crypto";
import type { ConversationStore } from "./store/conversation-store.js";
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
  level?: string;
}

export interface CompactionConfig {
  /** Context threshold as fraction of budget (default 0.75) */
  contextThreshold: number;
  /** Number of fresh tail turns to protect (default 8) */
  freshTailCount: number;
  /** Target tokens for leaf summaries (default 600) */
  leafTargetTokens: number;
  /** Target tokens for condensed summaries (default 900) */
  condensedTargetTokens: number;
  /** Maximum compaction rounds (default 10) */
  maxRounds: number;
}

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

  // ── compact ──────────────────────────────────────────────────────────────

  /** Run a single compaction round for a conversation. */
  async compact(input: {
    conversationId: number;
    tokenBudget: number;
    /** LLM call function for summarization */
    summarize: (text: string, aggressive?: boolean) => Promise<string>;
    force?: boolean;
  }): Promise<CompactionResult> {
    const { conversationId, tokenBudget, summarize, force } = input;

    const tokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
    const threshold = Math.floor(this.config.contextThreshold * tokenBudget);

    // Check if compaction is needed
    if (!force && tokensBefore <= threshold) {
      return {
        actionTaken: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        condensed: false,
      };
    }

    // Get all context items ordered by ordinal
    const contextItems = await this.summaryStore.getContextItems(conversationId);

    if (contextItems.length === 0) {
      return {
        actionTaken: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        condensed: false,
      };
    }

    // Separate into messages and summaries
    const messageItems = contextItems.filter((ci) => ci.itemType === "message");
    const summaryItems = contextItems.filter((ci) => ci.itemType === "summary");

    // ── Leaf Pass ─────────────────────────────────────────────────────────
    // Summarize oldest non-fresh messages

    // Protect the fresh tail: the last freshTailCount context items overall
    const freshCutoff = Math.max(0, contextItems.length - this.config.freshTailCount);
    // Messages eligible for compaction: those before the fresh tail boundary
    const freshOrdinal = contextItems[freshCutoff]?.ordinal ?? Infinity;
    const compactableMessages = messageItems.filter((ci) => ci.ordinal < freshOrdinal);

    let leafResult: {
      summaryId: string;
      level: string;
    } | null = null;

    if (compactableMessages.length > 0) {
      leafResult = await this.leafPass(conversationId, compactableMessages, summarize);
    }

    // Check if we are now under threshold after the leaf pass
    const tokensAfterLeaf = await this.summaryStore.getContextTokenCount(conversationId);
    if (tokensAfterLeaf <= threshold) {
      return {
        actionTaken: true,
        tokensBefore,
        tokensAfter: tokensAfterLeaf,
        createdSummaryId: leafResult?.summaryId,
        condensed: false,
        level: leafResult?.level,
      };
    }

    // ── Condensed Pass ────────────────────────────────────────────────────
    // Condense all summaries currently in context

    const updatedContextItems = await this.summaryStore.getContextItems(conversationId);
    const currentSummaryItems = updatedContextItems.filter((ci) => ci.itemType === "summary");

    if (currentSummaryItems.length === 0) {
      // Nothing to condense; return what we have
      return {
        actionTaken: leafResult !== null,
        tokensBefore,
        tokensAfter: tokensAfterLeaf,
        createdSummaryId: leafResult?.summaryId,
        condensed: false,
        level: leafResult?.level,
      };
    }

    const condenseResult = await this.condensedPass(conversationId, currentSummaryItems, summarize);

    const tokensAfterCondense = await this.summaryStore.getContextTokenCount(conversationId);

    return {
      actionTaken: true,
      tokensBefore,
      tokensAfter: tokensAfterCondense,
      createdSummaryId: condenseResult.summaryId,
      condensed: true,
      level: condenseResult.level,
    };
  }

  // ── compactUntilUnder ────────────────────────────────────────────────────

  /** Compact until under the requested target, running up to maxRounds. */
  async compactUntilUnder(input: {
    conversationId: number;
    tokenBudget: number;
    targetTokens?: number;
    currentTokens?: number;
    summarize: (text: string, aggressive?: boolean) => Promise<string>;
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

  // ── Private: Leaf Pass ───────────────────────────────────────────────────

  /**
   * Summarize a set of messages into a single leaf summary using three-level
   * escalation: normal -> aggressive -> deterministic fallback.
   */
  private async leafPass(
    conversationId: number,
    messageItems: ContextItemRecord[],
    summarize: (text: string, aggressive?: boolean) => Promise<string>,
  ): Promise<{ summaryId: string; level: string }> {
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
    const inputTokens = estimateTokens(concatenated);

    // Level 1: Normal summarization
    let summaryText = await summarize(concatenated, false);
    let level = "normal";

    // Convergence check: summary must be strictly smaller than input
    if (estimateTokens(summaryText) >= inputTokens) {
      // Level 2: Aggressive summarization
      summaryText = await summarize(concatenated, true);
      level = "aggressive";

      if (estimateTokens(summaryText) >= inputTokens) {
        // Level 3: Deterministic fallback -- truncate to 512 tokens worth of chars
        const truncated =
          concatenated.length > FALLBACK_MAX_CHARS
            ? concatenated.slice(0, FALLBACK_MAX_CHARS)
            : concatenated;
        summaryText = `${truncated}\n[Truncated from ${inputTokens} tokens]`;
        level = "fallback";
      }
    }

    // Persist the leaf summary
    const summaryId = generateSummaryId(summaryText);
    const tokenCount = estimateTokens(summaryText);

    await this.summaryStore.insertSummary({
      summaryId,
      conversationId,
      kind: "leaf",
      content: summaryText,
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

    return { summaryId, level };
  }

  // ── Private: Condensed Pass ──────────────────────────────────────────────

  /**
   * Condense all summaries currently in context into a single condensed
   * summary using three-level escalation.
   */
  private async condensedPass(
    conversationId: number,
    summaryItems: ContextItemRecord[],
    summarize: (text: string, aggressive?: boolean) => Promise<string>,
  ): Promise<{ summaryId: string; level: string }> {
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
    const inputTokens = estimateTokens(concatenated);

    // Level 1: Normal condensation
    let condensedText = await summarize(concatenated, false);
    let level = "normal";

    // Convergence check
    if (estimateTokens(condensedText) >= inputTokens) {
      // Level 2: Aggressive condensation
      condensedText = await summarize(concatenated, true);
      level = "aggressive";

      if (estimateTokens(condensedText) >= inputTokens) {
        // Level 3: Deterministic fallback
        const truncated =
          concatenated.length > FALLBACK_MAX_CHARS
            ? concatenated.slice(0, FALLBACK_MAX_CHARS)
            : concatenated;
        condensedText = `${truncated}\n[Truncated from ${inputTokens} tokens]`;
        level = "fallback";
      }
    }

    // Persist the condensed summary
    const summaryId = generateSummaryId(condensedText);
    const tokenCount = estimateTokens(condensedText);

    await this.summaryStore.insertSummary({
      summaryId,
      conversationId,
      kind: "condensed",
      content: condensedText,
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

    return { summaryId, level };
  }
}
