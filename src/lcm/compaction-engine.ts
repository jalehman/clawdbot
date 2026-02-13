import { randomUUID } from "node:crypto";
import type { LcmMetrics } from "./observability.js";
import type { TokenEstimator } from "./token-estimator.js";
import type {
  CompactionDecision,
  CompactionDecisionInput,
  CompactionDecisionReason,
  CompactionEngine,
  CompactionRequest,
  CompactionResult,
  ConversationId,
  ConversationStore,
  LcmContextItem,
  LcmSummary,
  MessageId,
  SummaryId,
  SummaryKind,
} from "./types.js";
import { buildConversationScopedItemId } from "./conversation-store.js";

const DEFAULT_CONTEXT_ITEMS_LIMIT = 2_000;
const DEFAULT_LEAF_BATCH_SIZE = 6;
const DEFAULT_CONDENSED_BATCH_SIZE = 3;
const MIN_ITEMS_FOR_SUMMARY = 2;

type CreateCompactionEngineParams = {
  store: ConversationStore;
  tokenEstimator: TokenEstimator;
  metrics?: LcmMetrics;
  leafBatchSize?: number;
  condensedBatchSize?: number;
};

type LeafBatchResult = {
  compacted: boolean;
  summary?: LcmSummary;
};

type CondensedBatchResult = {
  compacted: boolean;
  summary?: LcmSummary;
};

/**
 * Create the default LCM compaction engine.
 */
export function createCompactionEngine(params: CreateCompactionEngineParams): CompactionEngine {
  return new DefaultCompactionEngine(params);
}

/**
 * SQLite-backed compaction engine with conversation-scoped advisory locking.
 */
class DefaultCompactionEngine implements CompactionEngine {
  private readonly store: ConversationStore;
  private readonly tokenEstimator: TokenEstimator;
  private readonly metrics: LcmMetrics | null;
  private readonly leafBatchSize: number;
  private readonly condensedBatchSize: number;
  private readonly conversationLocks = new Map<string, Promise<void>>();

  /**
   * Construct a compaction engine from store + tokenizer dependencies.
   */
  constructor(params: CreateCompactionEngineParams) {
    this.store = params.store;
    this.tokenEstimator = params.tokenEstimator;
    this.metrics = params.metrics ?? null;
    this.leafBatchSize = clampInt(params.leafBatchSize, DEFAULT_LEAF_BATCH_SIZE, 2, 64);
    this.condensedBatchSize = clampInt(
      params.condensedBatchSize,
      DEFAULT_CONDENSED_BATCH_SIZE,
      2,
      32,
    );
  }

  /**
   * Evaluate whether compaction should run for a conversation.
   */
  async evaluate(input: CompactionDecisionInput): Promise<CompactionDecision> {
    const contextThreshold = clampFloat(input.contextThreshold, 0.8, 0.1, 1.25);
    const modelTokenBudget = Math.max(1, Math.trunc(input.modelTokenBudget));
    const assembledTokens = Math.max(0, Math.trunc(input.assembledTokens));
    const maxActiveMessages = Math.max(1, Math.trunc(input.maxActiveMessages));
    const activeMessageCount = await this.countActiveMessages(input.conversationId);
    const tokenTriggerThreshold = Math.floor(contextThreshold * modelTokenBudget);

    const reason = resolveDecisionReason({
      manual: input.manual === true,
      assembledTokens,
      tokenTriggerThreshold,
      activeMessageCount,
      maxActiveMessages,
    });

    return {
      shouldCompact: reason !== "none",
      reason,
      assembledTokens,
      activeMessageCount,
      tokenTriggerThreshold,
      maxActiveMessages,
    };
  }

  /**
   * Compact one conversation by running leaf and condensed passes under lock.
   */
  async compact(request: CompactionRequest): Promise<CompactionResult> {
    return this.withConversationLock(request.conversationId, async () => {
      const compactionId = randomUUID();
      const decision = await this.evaluate({
        conversationId: request.conversationId,
        assembledTokens: request.assembledTokens,
        modelTokenBudget: request.modelTokenBudget,
        contextThreshold: request.contextThreshold,
        maxActiveMessages: request.maxActiveMessages,
        manual: request.manual,
      });

      const tokensBefore = await this.estimateActiveContextTokens(request.conversationId);
      this.metrics?.recordContextTokens({
        conversationId: request.conversationId,
        tokens: tokensBefore,
      });
      const activeMessageCountBefore = decision.activeMessageCount;

      if (!decision.shouldCompact) {
        this.metrics?.recordCompactionRun({
          conversationId: request.conversationId,
          compactionId,
          triggerReason: decision.reason,
          tokenBefore: tokensBefore,
          tokenAfter: tokensBefore,
        });
        return {
          compacted: false,
          summaries: [],
          tokensBefore,
          tokensAfter: tokensBefore,
          activeMessageCountBefore,
          activeMessageCountAfter: activeMessageCountBefore,
          decision,
          batches: { leaf: 0, condensed: 0 },
          reason: "Compaction thresholds not met.",
        };
      }

      const summaries: LcmSummary[] = [];
      let leafBatches = 0;
      let condensedBatches = 0;

      while (true) {
        const leaf = await this.runLeafBatch({
          conversationId: request.conversationId,
          freshTailCount: request.freshTailCount,
          customInstructions: request.customInstructions,
        });
        if (!leaf.compacted || !leaf.summary) {
          break;
        }
        summaries.push(leaf.summary);
        this.metrics?.recordSummaryCreated({
          conversationId: request.conversationId,
          compactionId,
          summaryId: leaf.summary.id,
          kind: leaf.summary.kind,
        });
        leafBatches += 1;

        const remainingTokens = await this.estimateActiveContextTokens(request.conversationId);
        if (remainingTokens <= request.targetTokens) {
          break;
        }
      }

      while (true) {
        const condensed = await this.runCondensedBatch({
          conversationId: request.conversationId,
          customInstructions: request.customInstructions,
        });
        if (!condensed.compacted || !condensed.summary) {
          break;
        }
        summaries.push(condensed.summary);
        this.metrics?.recordSummaryCreated({
          conversationId: request.conversationId,
          compactionId,
          summaryId: condensed.summary.id,
          kind: condensed.summary.kind,
        });
        condensedBatches += 1;

        const remainingTokens = await this.estimateActiveContextTokens(request.conversationId);
        if (remainingTokens <= request.targetTokens) {
          break;
        }
      }

      const tokensAfter = await this.estimateActiveContextTokens(request.conversationId);
      this.metrics?.recordContextTokens({
        conversationId: request.conversationId,
        tokens: tokensAfter,
      });
      this.metrics?.recordCompactionRun({
        conversationId: request.conversationId,
        compactionId,
        triggerReason: decision.reason,
        tokenBefore: tokensBefore,
        tokenAfter: tokensAfter,
      });
      const activeMessageCountAfter = await this.countActiveMessages(request.conversationId);

      return {
        compacted: summaries.length > 0,
        summaries,
        tokensBefore,
        tokensAfter,
        activeMessageCountBefore,
        activeMessageCountAfter,
        decision,
        batches: {
          leaf: leafBatches,
          condensed: condensedBatches,
        },
        reason: summaries.length > 0 ? undefined : "No eligible context ranges for compaction.",
      };
    });
  }

  /**
   * Summarize oldest eligible raw messages into one leaf summary.
   */
  private async runLeafBatch(params: {
    conversationId: ConversationId;
    freshTailCount: number;
    customInstructions?: string;
  }): Promise<LeafBatchResult> {
    const freshTailCount = Math.max(0, Math.trunc(params.freshTailCount));

    const messageItems = await this.store.getContextItems({
      conversationId: params.conversationId,
      includeTombstoned: false,
      itemTypes: ["message"],
      limit: DEFAULT_CONTEXT_ITEMS_LIMIT,
    });

    const protectedStartIndex = Math.max(0, messageItems.length - freshTailCount);
    const eligible = messageItems.slice(0, protectedStartIndex);
    if (eligible.length < MIN_ITEMS_FOR_SUMMARY) {
      return { compacted: false };
    }

    const batch = eligible.slice(0, this.leafBatchSize);
    if (batch.length < MIN_ITEMS_FOR_SUMMARY) {
      return { compacted: false };
    }

    const messageIds = batch
      .map((item) => item.sourceMessageId)
      .filter((value): value is MessageId => Boolean(value));
    if (messageIds.length < MIN_ITEMS_FOR_SUMMARY) {
      return { compacted: false };
    }

    const messages = await this.store.listMessages({
      conversationId: params.conversationId,
      messageIds,
      limit: messageIds.length,
    });
    if (messages.length < MIN_ITEMS_FOR_SUMMARY) {
      return { compacted: false };
    }

    const startItem = batch[0];
    const endItem = batch[batch.length - 1];
    const startMessage = messages[0];
    const endMessage = messages[messages.length - 1];
    if (!startItem || !endItem || !startMessage || !endMessage) {
      return { compacted: false };
    }

    const nowMs = Date.now();
    const summaryId = buildConversationScopedItemId(
      "sumleaf",
      params.conversationId,
      `${startMessage.messageId}:${endMessage.messageId}:${nowMs}`,
    ) as LcmSummary["id"];

    const summaryBody = buildLeafSummaryBody(messages, params.customInstructions);
    const summaryTitle = `Compacted ${messages.length} messages`;

    await this.store.withTransaction(async (txStore) => {
      await txStore.insertSummary({
        summaryId,
        conversationId: params.conversationId,
        sourceMessageId: startMessage.messageId,
        depth: 1,
        title: summaryTitle,
        body: summaryBody,
        metadata: {
          kind: "leaf",
          source: "compaction",
          sourceMessageCount: messages.length,
          sourceStartOrdinal: startMessage.ordinal,
          sourceEndOrdinal: endMessage.ordinal,
        },
        createdAtMs: nowMs,
      });

      await txStore.linkSummaryToMessages({
        conversationId: params.conversationId,
        summaryId,
        messageIds,
        relation: "summarizes",
        metadata: {
          kind: "leaf",
        },
        createdAtMs: nowMs,
      });

      await txStore.replaceContextRangeWithSummary({
        conversationId: params.conversationId,
        summaryId,
        startItemId: startItem.itemId,
        endItemId: endItem.itemId,
        metadata: {
          kind: "leaf",
        },
        updatedAtMs: nowMs,
      });
    });

    return {
      compacted: true,
      summary: {
        id: summaryId,
        conversationId: params.conversationId,
        kind: "leaf",
        text: `${summaryTitle}\n${summaryBody}`,
        messageStartId: startMessage.messageId,
        messageEndId: endMessage.messageId,
        tokenEstimate: this.tokenEstimator.estimateText(`${summaryTitle}\n${summaryBody}`),
        createdAt: new Date(nowMs).toISOString(),
      },
    };
  }

  /**
   * Merge adjacent stale leaf summaries into one condensed summary.
   */
  private async runCondensedBatch(params: {
    conversationId: ConversationId;
    customInstructions?: string;
  }): Promise<CondensedBatchResult> {
    const contextItems = await this.store.getContextItems({
      conversationId: params.conversationId,
      includeTombstoned: false,
      itemTypes: ["message", "summary"],
      limit: DEFAULT_CONTEXT_ITEMS_LIMIT,
    });

    const newestMessageTs = contextItems
      .filter((item) => item.itemType === "message")
      .map((item) => item.createdAtMs)
      .at(-1);

    const staleLeafSet = new Set(
      contextItems
        .filter((item) => item.itemType === "summary")
        .filter((item) => parseSummaryKind(item.metadata.kind) === "leaf")
        .filter((item) =>
          newestMessageTs === undefined ? true : item.createdAtMs < newestMessageTs,
        )
        .map((item) => item.itemId),
    );

    if (staleLeafSet.size < MIN_ITEMS_FOR_SUMMARY) {
      return { compacted: false };
    }

    const run = findFirstAdjacentLeafRun(contextItems, staleLeafSet, this.condensedBatchSize);
    if (run.length < MIN_ITEMS_FOR_SUMMARY) {
      return { compacted: false };
    }

    const parentSummaryIds = run.map((item) => item.itemId as LcmSummary["id"]);
    const summaryBody = buildCondensedSummaryBody(run, params.customInstructions);

    const firstLeaf = run[0];
    const lastLeaf = run[run.length - 1];
    if (!firstLeaf || !lastLeaf) {
      return { compacted: false };
    }

    const firstRange = await this.store.getSummaryMessages(firstLeaf.itemId as SummaryId, 1);
    const lastRange = await this.store.getSummaryMessages(
      lastLeaf.itemId as SummaryId,
      DEFAULT_CONTEXT_ITEMS_LIMIT,
    );
    const startMessageId = firstRange[0]?.messageId;
    const endMessageId = lastRange[lastRange.length - 1]?.messageId;
    if (!startMessageId || !endMessageId) {
      return { compacted: false };
    }

    const nowMs = Date.now();
    const summaryId = buildConversationScopedItemId(
      "sumcond",
      params.conversationId,
      `${firstLeaf.itemId}:${lastLeaf.itemId}:${nowMs}`,
    ) as LcmSummary["id"];

    const summaryTitle = `Condensed ${run.length} leaf summaries`;

    await this.store.withTransaction(async (txStore) => {
      await txStore.insertSummary({
        summaryId,
        conversationId: params.conversationId,
        sourceMessageId: startMessageId,
        depth: 2,
        title: summaryTitle,
        body: summaryBody,
        metadata: {
          kind: "condensed",
          source: "compaction",
          mergedLeafSummaryIds: parentSummaryIds,
        },
        createdAtMs: nowMs,
      });

      await txStore.linkSummaryToParents({
        summaryId,
        parentSummaryIds,
        relation: "condenses",
        metadata: {
          kind: "condensed",
        },
        createdAtMs: nowMs,
      });

      await txStore.replaceContextRangeWithSummary({
        conversationId: params.conversationId,
        summaryId,
        startItemId: firstLeaf.itemId,
        endItemId: lastLeaf.itemId,
        metadata: {
          kind: "condensed",
        },
        updatedAtMs: nowMs,
      });
    });

    return {
      compacted: true,
      summary: {
        id: summaryId,
        conversationId: params.conversationId,
        kind: "condensed",
        text: `${summaryTitle}\n${summaryBody}`,
        messageStartId: startMessageId,
        messageEndId: endMessageId,
        tokenEstimate: this.tokenEstimator.estimateText(`${summaryTitle}\n${summaryBody}`),
        createdAt: new Date(nowMs).toISOString(),
      },
    };
  }

  /**
   * Estimate active context tokens from message and summary item bodies.
   */
  private async estimateActiveContextTokens(conversationId: ConversationId): Promise<number> {
    const items = await this.store.getContextItems({
      conversationId,
      includeTombstoned: false,
      itemTypes: ["message", "summary"],
      limit: DEFAULT_CONTEXT_ITEMS_LIMIT,
    });

    let total = 0;
    for (const item of items) {
      const text = item.title ? `${item.title}\n${item.body}` : item.body;
      total += this.tokenEstimator.estimateText(text);
    }
    return total;
  }

  /**
   * Count active raw message context items.
   */
  private async countActiveMessages(conversationId: ConversationId): Promise<number> {
    const items = await this.store.getContextItems({
      conversationId,
      includeTombstoned: false,
      itemTypes: ["message"],
      limit: DEFAULT_CONTEXT_ITEMS_LIMIT,
    });
    return items.length;
  }

  /**
   * Serialize compaction per conversation without blocking unrelated conversations.
   */
  private async withConversationLock<T>(
    conversationId: ConversationId,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = String(conversationId);
    const previous = this.conversationLocks.get(key) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => gate);
    this.conversationLocks.set(key, chain);

    await previous;

    try {
      return await fn();
    } finally {
      release();
      if (this.conversationLocks.get(key) === chain) {
        this.conversationLocks.delete(key);
      }
    }
  }
}

function buildLeafSummaryBody(
  messages: Array<{ role: string; ordinal: number; contentText: string }>,
  customInstructions?: string,
): string {
  const lines: string[] = [];
  if (customInstructions?.trim()) {
    lines.push(`Instructions: ${customInstructions.trim()}`);
  }
  lines.push("Key points from older conversation turns:");
  for (const message of messages) {
    const excerpt = truncateText(message.contentText, 220);
    lines.push(`- [${message.ordinal}] ${message.role}: ${excerpt}`);
  }
  return lines.join("\n");
}

function buildCondensedSummaryBody(
  leafItems: Array<Pick<LcmContextItem, "title" | "body">>,
  customInstructions?: string,
): string {
  const lines: string[] = [];
  if (customInstructions?.trim()) {
    lines.push(`Instructions: ${customInstructions.trim()}`);
  }
  lines.push("Merged history of prior compaction summaries:");
  for (const leaf of leafItems) {
    const prefix = leaf.title ? `${leaf.title}: ` : "";
    lines.push(`- ${prefix}${truncateText(leaf.body, 220)}`);
  }
  return lines.join("\n");
}

function findFirstAdjacentLeafRun(
  items: LcmContextItem[],
  leafIds: Set<string>,
  maxSize: number,
): LcmContextItem[] {
  const run: LcmContextItem[] = [];
  for (const item of items) {
    if (item.itemType !== "summary" || !leafIds.has(item.itemId)) {
      if (run.length >= MIN_ITEMS_FOR_SUMMARY) {
        break;
      }
      run.length = 0;
      continue;
    }

    run.push(item);
    if (run.length >= maxSize) {
      break;
    }
  }
  return run;
}

function resolveDecisionReason(params: {
  manual: boolean;
  assembledTokens: number;
  tokenTriggerThreshold: number;
  activeMessageCount: number;
  maxActiveMessages: number;
}): CompactionDecisionReason {
  if (params.manual) {
    return "manual";
  }
  if (params.assembledTokens >= params.tokenTriggerThreshold) {
    return "token_threshold";
  }
  if (params.activeMessageCount > params.maxActiveMessages) {
    return "message_threshold";
  }
  return "none";
}

function parseSummaryKind(value: unknown): SummaryKind {
  if (
    value === "rolling" ||
    value === "compaction" ||
    value === "checkpoint" ||
    value === "topic" ||
    value === "leaf" ||
    value === "condensed"
  ) {
    return value;
  }
  return "compaction";
}

function truncateText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampFloat(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}
