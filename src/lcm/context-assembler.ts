import type { TokenEstimator } from "./token-estimator.js";
import type {
  AssembleContextInput,
  AssembleContextResult,
  ContextAssembler,
  ConversationStore,
  LcmContextItem,
  LcmMessage,
  LcmSummary,
  StoredLcmMessage,
  SummaryId,
  SummaryKind,
} from "./types.js";

const MAX_CONTEXT_ITEMS = 2_000;

type CreateContextAssemblerParams = {
  store: ConversationStore;
  tokenEstimator: TokenEstimator;
};

type ScoredSummary = {
  summary: LcmSummary;
  score: number;
  createdAtMs: number;
};

/**
 * Create a deterministic context assembler that merges fresh raw turns and summaries.
 */
export function createContextAssembler(params: CreateContextAssemblerParams): ContextAssembler {
  return new DefaultContextAssembler(params);
}

/**
 * SQLite-backed context assembler used by the LCM runtime.
 */
class DefaultContextAssembler implements ContextAssembler {
  private readonly store: ConversationStore;
  private readonly tokenEstimator: TokenEstimator;

  /**
   * Construct an assembler from store + token-estimation dependencies.
   */
  constructor(params: CreateContextAssemblerParams) {
    this.store = params.store;
    this.tokenEstimator = params.tokenEstimator;
  }

  /**
   * Assemble model-ready context from active message and summary items.
   */
  async assemble(input: AssembleContextInput): Promise<AssembleContextResult> {
    const targetTokens = Math.max(1, Math.trunc(input.targetTokens));
    const freshTailCount = Math.max(0, Math.trunc(input.freshTailCount));

    const contextItems = await this.store.getContextItems({
      conversationId: input.conversationId,
      includeTombstoned: false,
      itemTypes: ["message", "summary"],
      limit: MAX_CONTEXT_ITEMS,
    });

    const messageItems = contextItems.filter(
      (item): item is LcmContextItem & { itemType: "message" } => item.itemType === "message",
    );
    const summaryItems = contextItems.filter(
      (item): item is LcmContextItem & { itemType: "summary" } => item.itemType === "summary",
    );

    const orderedMessages = await this.resolveActiveMessages(input.conversationId, messageItems);
    const policyMessages = orderedMessages.filter((message) => isSystemOrPolicyMessage(message));
    const nonPolicyMessages = orderedMessages.filter(
      (message) => !isSystemOrPolicyMessage(message),
    );

    const selectedPolicyMessages = this.selectPolicyMessages(policyMessages, targetTokens);
    let totalTokens = this.estimateMessageTokens(selectedPolicyMessages);

    const selectedFreshTail = this.selectFreshTailMessages({
      messages: nonPolicyMessages,
      count: freshTailCount,
      targetTokens,
      alreadyUsedTokens: totalTokens,
    });
    totalTokens += this.estimateMessageTokens(selectedFreshTail);

    const oldestFreshTailCreatedAtMs = selectedFreshTail[0]?.createdAtMs;
    const scoredSummaries = await this.scoreSummaryCandidates({
      summaryItems,
      anchorMessages: selectedFreshTail,
      maxCreatedAtMs: oldestFreshTailCreatedAtMs,
    });

    const selectedSummaries: LcmSummary[] = [];
    for (const candidate of scoredSummaries) {
      const estimate =
        candidate.summary.tokenEstimate ?? this.tokenEstimator.estimateText(candidate.summary.text);
      if (totalTokens + estimate > targetTokens) {
        continue;
      }
      selectedSummaries.push(candidate.summary);
      totalTokens += estimate;
    }

    return {
      conversationId: input.conversationId,
      messages: [...selectedPolicyMessages, ...selectedFreshTail].map((message) =>
        toLcmMessage(message, this.tokenEstimator),
      ),
      summaries: selectedSummaries,
      tokenEstimate: totalTokens,
    };
  }

  /**
   * Resolve active context-message pointers into canonical messages in ordinal order.
   */
  private async resolveActiveMessages(
    conversationId: AssembleContextInput["conversationId"],
    items: Array<LcmContextItem & { itemType: "message" }>,
  ): Promise<StoredLcmMessage[]> {
    const orderedIds = items
      .map((item) => item.sourceMessageId)
      .filter((value): value is NonNullable<typeof value> => Boolean(value));
    const uniqueIds = Array.from(new Set(orderedIds));
    if (uniqueIds.length === 0) {
      return [];
    }

    const messages = await this.store.listMessages({
      conversationId,
      messageIds: uniqueIds,
      limit: uniqueIds.length,
    });

    const messageById = new Map(messages.map((message) => [message.messageId, message]));
    const ordered: StoredLcmMessage[] = [];
    for (const id of uniqueIds) {
      const message = messageById.get(id);
      if (message) {
        ordered.push(message);
      }
    }

    ordered.sort((a, b) => a.ordinal - b.ordinal || a.messageId.localeCompare(b.messageId));
    return ordered;
  }

  /**
   * Always retain policy messages first, even if they exceed the target budget.
   */
  private selectPolicyMessages(
    messages: StoredLcmMessage[],
    targetTokens: number,
  ): StoredLcmMessage[] {
    if (messages.length === 0) {
      return [];
    }

    const selected: StoredLcmMessage[] = [];
    let total = 0;
    for (const message of messages) {
      selected.push(message);
      total += estimateStoredMessageTokens(message, this.tokenEstimator);
      if (total > targetTokens) {
        // Keep going intentionally: policy content has priority over strict budgeting.
        continue;
      }
    }
    return selected;
  }

  /**
   * Pick freshest messages first, then restore chronological order.
   */
  private selectFreshTailMessages(params: {
    messages: StoredLcmMessage[];
    count: number;
    targetTokens: number;
    alreadyUsedTokens: number;
  }): StoredLcmMessage[] {
    if (params.count <= 0 || params.messages.length === 0) {
      return [];
    }

    const selected: StoredLcmMessage[] = [];
    let used = params.alreadyUsedTokens;

    for (
      let index = params.messages.length - 1;
      index >= 0 && selected.length < params.count;
      index -= 1
    ) {
      const message = params.messages[index];
      if (!message) {
        continue;
      }
      const estimate = estimateStoredMessageTokens(message, this.tokenEstimator);
      if (used + estimate > params.targetTokens) {
        continue;
      }
      selected.push(message);
      used += estimate;
    }

    selected.sort((a, b) => a.ordinal - b.ordinal || a.messageId.localeCompare(b.messageId));
    return selected;
  }

  /**
   * Rank candidate summaries by lexical relevance to the fresh tail, then recency.
   */
  private async scoreSummaryCandidates(params: {
    summaryItems: Array<LcmContextItem & { itemType: "summary" }>;
    anchorMessages: StoredLcmMessage[];
    maxCreatedAtMs?: number;
  }): Promise<ScoredSummary[]> {
    const anchors = params.anchorMessages.map((message) => message.contentText).join("\n");
    const anchorTerms = tokenizeTerms(anchors);

    const scored: ScoredSummary[] = [];
    for (const item of params.summaryItems) {
      if (params.maxCreatedAtMs !== undefined && item.createdAtMs >= params.maxCreatedAtMs) {
        continue;
      }

      const range = await this.store.getSummaryMessages(item.itemId as SummaryId, 2);
      const startId = range[0]?.messageId;
      const endId = range[range.length - 1]?.messageId;
      if (!startId || !endId) {
        continue;
      }

      const kind = parseSummaryKind(item.metadata.kind);
      const text = item.title ? `${item.title}\n${item.body}` : item.body;
      const tokenEstimate = this.tokenEstimator.estimateText(text);
      const summary: LcmSummary = {
        id: item.itemId as SummaryId,
        conversationId: item.conversationId,
        kind,
        text,
        messageStartId: startId,
        messageEndId: endId,
        tokenEstimate,
        createdAt: toIsoTimestamp(item.createdAtMs),
      };
      scored.push({
        summary,
        score: lexicalOverlapScore(anchorTerms, tokenizeTerms(item.body)),
        createdAtMs: item.createdAtMs,
      });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (b.createdAtMs !== a.createdAtMs) {
        return b.createdAtMs - a.createdAtMs;
      }
      return a.summary.id.localeCompare(b.summary.id);
    });
    return scored;
  }

  private estimateMessageTokens(messages: StoredLcmMessage[]): number {
    let total = 0;
    for (const message of messages) {
      total += estimateStoredMessageTokens(message, this.tokenEstimator);
    }
    return total;
  }
}

function isSystemOrPolicyMessage(message: StoredLcmMessage): boolean {
  if (message.role === "system") {
    return true;
  }

  const policyFlag = message.payload.policy;
  if (typeof policyFlag === "boolean") {
    return policyFlag;
  }

  const text = message.contentText.trimStart().toLowerCase();
  return text.startsWith("policy:") || text.startsWith("instruction:");
}

function estimateStoredMessageTokens(
  message: StoredLcmMessage,
  tokenEstimator: TokenEstimator,
): number {
  return tokenEstimator.estimateText(message.contentText);
}

function toLcmMessage(message: StoredLcmMessage, tokenEstimator: TokenEstimator): LcmMessage {
  return {
    id: message.messageId,
    conversationId: message.conversationId,
    role: message.role,
    content: message.contentText,
    tokenEstimate: estimateStoredMessageTokens(message, tokenEstimator),
    createdAt: toIsoTimestamp(message.createdAtMs),
  };
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

function lexicalOverlapScore(anchorTerms: Set<string>, candidateTerms: Set<string>): number {
  if (anchorTerms.size === 0 || candidateTerms.size === 0) {
    return 0;
  }

  let matches = 0;
  for (const term of candidateTerms) {
    if (anchorTerms.has(term)) {
      matches += 1;
    }
  }

  return matches / candidateTerms.size;
}

function tokenizeTerms(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  return new Set(matches);
}

function toIsoTimestamp(value: number): string {
  return new Date(value).toISOString();
}
