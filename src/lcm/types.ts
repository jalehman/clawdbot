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
 * Storage abstraction for message/summary persistence.
 */
export type ConversationStore = {
  getMessages(conversationId: ConversationId): Promise<LcmMessage[]>;
  appendMessages(conversationId: ConversationId, messages: LcmMessage[]): Promise<void>;
  getSummaries(conversationId: ConversationId): Promise<LcmSummary[]>;
  appendSummary(conversationId: ConversationId, summary: LcmSummary): Promise<void>;
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
