import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Nominal branding helper for LCM identifiers.
 */
type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

export type ConversationId = Brand<string, "ConversationId">;
export type MessageId = Brand<string, "MessageId">;
export type SummaryId = Brand<string, "SummaryId">;
export type FactId = Brand<string, "FactId">;
export type AnchorId = Brand<string, "AnchorId">;

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type SummaryKind = "rolling" | "compaction" | "checkpoint" | "topic";
export type IntegritySeverity = "info" | "warn" | "error";

/**
 * Canonical LCM message representation persisted by stores.
 */
export type LcmMessage = {
  id: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  content: string;
  source?: AgentMessage;
  tokenEstimate?: number;
  createdAt: string;
};

/**
 * Summary record connecting a span of messages.
 */
export type LcmSummary = {
  id: SummaryId;
  conversationId: ConversationId;
  kind: SummaryKind;
  text: string;
  messageStartId: MessageId;
  messageEndId: MessageId;
  tokenEstimate?: number;
  createdAt: string;
};

/**
 * Optional extracted fact record.
 */
export type LcmFact = {
  id: FactId;
  conversationId: ConversationId;
  content: string;
  summaryIds: SummaryId[];
  createdAt: string;
};

/**
 * Integrity issue emitted by checks.
 */
export type LcmIntegrityIssue = {
  severity: IntegritySeverity;
  code: string;
  message: string;
  conversationId: ConversationId;
  relatedMessageId?: MessageId;
  relatedSummaryId?: SummaryId;
};

/**
 * Context assembly request.
 */
export type AssembleContextInput = {
  conversationId: ConversationId;
  targetTokens: number;
  freshTailCount: number;
  includeFacts?: boolean;
  includeAnchors?: boolean;
};

/**
 * Final assembled context payload.
 */
export type AssembledContext = {
  conversationId: ConversationId;
  messages: LcmMessage[];
  summaries: LcmSummary[];
  facts?: LcmFact[];
  tokenEstimate: number;
};

/**
 * Compaction request.
 */
export type CompactionRequest = {
  conversationId: ConversationId;
  currentTokenEstimate: number;
  targetTokens: number;
  customInstructions?: string;
};

/**
 * Compaction output.
 */
export type CompactionResult = {
  compacted: boolean;
  summary?: LcmSummary;
  deletedMessageIds?: MessageId[];
  tokensBefore: number;
  tokensAfter?: number;
  reason?: string;
};

/**
 * Free-text retrieval request.
 */
export type RetrievalQuery = {
  conversationId: ConversationId;
  query: string;
  limit?: number;
};

/**
 * Summary expansion request.
 */
export type ExpansionQuery = {
  conversationId: ConversationId;
  summaryId: SummaryId;
  limit?: number;
};

/**
 * Retrieval hit record.
 */
export type RetrievalHit = {
  messageId: MessageId;
  score?: number;
  snippet: string;
};

/**
 * Describe query output for retrieval introspection.
 */
export type RetrievalDescribeResult = {
  conversationId: ConversationId;
  messageCount: number;
  summaryCount: number;
  latestMessageId?: MessageId;
  latestSummaryId?: SummaryId;
};

/**
 * Canonical persisted message record in SQLite.
 */
export type StoredLcmMessage = {
  messageId: MessageId;
  conversationId: ConversationId;
  ordinal: number;
  role: MessageRole;
  authorId?: string;
  contentText: string;
  payload: Record<string, unknown>;
  createdAtMs: number;
};

/**
 * Part kind stored for canonical message payload blocks.
 */
export type LcmMessagePartKind =
  | "text"
  | "image"
  | "toolCall"
  | "toolResult"
  | "thinking"
  | "json"
  | "other";

/**
 * Canonical message part derived from rich AgentMessage content blocks.
 */
export type StoredLcmMessagePart = {
  partId: string;
  messageId: MessageId;
  partIndex: number;
  kind: LcmMessagePartKind;
  mimeType?: string;
  textContent?: string;
  blobPath?: string;
  tokenCount?: number;
  payload: Record<string, unknown>;
  createdAtMs: number;
};

/**
 * Context item persisted in the active context graph.
 */
export type LcmContextItemType = "message" | "summary" | "note" | "artifact";

/**
 * Canonical context item row.
 */
export type LcmContextItem = {
  itemId: string;
  conversationId: ConversationId;
  sourceMessageId?: MessageId;
  itemType: LcmContextItemType;
  depth: number;
  title?: string;
  body: string;
  metadata: Record<string, unknown>;
  tombstoned: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};

/**
 * Summary item specialization.
 */
export type LcmSummaryItem = LcmContextItem & {
  itemType: "summary";
};

/**
 * Create canonical message input.
 */
export type CreateMessageInput = {
  messageId: MessageId;
  conversationId: ConversationId;
  sessionId: string;
  channel?: string;
  ordinal: number;
  role: MessageRole;
  authorId?: string;
  contentText: string;
  payload: Record<string, unknown>;
  createdAtMs: number;
};

/**
 * Create canonical message parts input.
 */
export type CreateMessagePartsInput = {
  messageId: MessageId;
  parts: StoredLcmMessagePart[];
};

/**
 * Insert summary input.
 */
export type InsertSummaryInput = {
  summaryId: SummaryId;
  conversationId: ConversationId;
  sourceMessageId?: MessageId;
  depth?: number;
  title?: string;
  body: string;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
};

/**
 * Link summary to direct message parents.
 */
export type LinkSummaryToMessagesInput = {
  conversationId: ConversationId;
  summaryId: SummaryId;
  messageIds: MessageId[];
  relation?: string;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
};

/**
 * Link summary to parent summaries.
 */
export type LinkSummaryToParentsInput = {
  summaryId: SummaryId;
  parentSummaryIds: SummaryId[];
  relation?: string;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
};

/**
 * Replace a context range with a summary and tombstone replaced items.
 */
export type ReplaceContextRangeWithSummaryInput = {
  conversationId: ConversationId;
  summaryId: SummaryId;
  startItemId: string;
  endItemId: string;
  metadata?: Record<string, unknown>;
  updatedAtMs: number;
};

/**
 * Append a context message item tied to a canonical message.
 */
export type AppendContextMessageInput = {
  itemId: string;
  conversationId: ConversationId;
  messageId: MessageId;
  depth?: number;
  title?: string;
  body: string;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
};

/**
 * Context item query options.
 */
export type GetContextItemsInput = {
  conversationId: ConversationId;
  includeTombstoned?: boolean;
  itemTypes?: LcmContextItemType[];
  limit?: number;
};

/**
 * Message search query.
 */
export type SearchMessagesInput = {
  conversationId: ConversationId;
  query: string;
  limit?: number;
};

/**
 * Summary search query.
 */
export type SearchSummariesInput = {
  conversationId: ConversationId;
  query: string;
  limit?: number;
};

/**
 * Canonical message search hit.
 */
export type LcmMessageSearchHit = {
  messageId: MessageId;
  conversationId: ConversationId;
  ordinal: number;
  role: MessageRole;
  snippet: string;
  createdAtMs: number;
};

/**
 * Summary search hit from context-item graph.
 */
export type LcmSummarySearchHit = {
  summaryId: SummaryId;
  conversationId: ConversationId;
  title?: string;
  snippet: string;
  score?: number;
  createdAtMs: number;
};

/**
 * Storage abstraction for canonical conversation ingestion + lineage graph.
 */
export type ConversationStore = {
  createMessage(input: CreateMessageInput): Promise<StoredLcmMessage>;
  createMessageParts(input: CreateMessagePartsInput): Promise<void>;
  insertSummary(input: InsertSummaryInput): Promise<LcmSummaryItem>;
  linkSummaryToMessages(input: LinkSummaryToMessagesInput): Promise<void>;
  linkSummaryToParents(input: LinkSummaryToParentsInput): Promise<void>;
  replaceContextRangeWithSummary(input: ReplaceContextRangeWithSummaryInput): Promise<number>;
  appendContextMessage(input: AppendContextMessageInput): Promise<LcmContextItem>;
  getContextItems(input: GetContextItemsInput): Promise<LcmContextItem[]>;
  getSummary(summaryId: SummaryId): Promise<LcmSummaryItem | null>;
  getSummaryChildren(summaryId: SummaryId): Promise<LcmSummaryItem[]>;
  getSummaryMessages(summaryId: SummaryId, limit?: number): Promise<StoredLcmMessage[]>;
  searchMessages(input: SearchMessagesInput): Promise<LcmMessageSearchHit[]>;
  searchSummaries(input: SearchSummariesInput): Promise<LcmSummarySearchHit[]>;
};

/**
 * Message assembler abstraction.
 */
export type ContextAssembler = {
  assemble(input: AssembleContextInput): Promise<AssembledContext>;
};

/**
 * Message compaction abstraction.
 */
export type CompactionEngine = {
  compact(request: CompactionRequest): Promise<CompactionResult>;
};

/**
 * Retrieval abstraction used by LCM tools.
 */
export type RetrievalEngine = {
  describe(conversationId: ConversationId): Promise<RetrievalDescribeResult>;
  grep(query: RetrievalQuery): Promise<RetrievalHit[]>;
  expand(query: ExpansionQuery): Promise<LcmMessage[]>;
};

/**
 * Integrity checker abstraction used for chain validation.
 */
export type IntegrityChecker = {
  checkConversation(conversationId: ConversationId): Promise<LcmIntegrityIssue[]>;
};

/**
 * Runtime dependency bundle used to build the LCM plugin and engine.
 */
export type LcmRuntime = {
  store?: ConversationStore;
  assembler?: ContextAssembler;
  compaction?: CompactionEngine;
  retrieval?: RetrievalEngine;
  integrity?: IntegrityChecker;
};
