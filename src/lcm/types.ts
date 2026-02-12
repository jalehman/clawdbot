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
 * Describe target kinds supported by retrieval introspection.
 */
export type RetrievalDescribeKind = "summary" | "file";

/**
 * Retrieval search modes.
 */
export type RetrievalGrepMode = "regex" | "full_text";

/**
 * Retrieval search scope selectors.
 */
export type RetrievalGrepScope = "messages" | "summaries" | "both";

/**
 * Lineage metadata for summary describe responses.
 */
export type RetrievalLineage = {
  parentIds: string[];
  childIds: string[];
};

/**
 * Source message range resolved from lineage traversal.
 */
export type RetrievalSourceMessageRange = {
  startId: MessageId;
  endId: MessageId;
  count: number;
};

/**
 * Summary describe payload.
 */
export type RetrievalSummaryDescribeResult = {
  id: SummaryId;
  kind: "summary";
  conversationId: ConversationId;
  itemType: string;
  title?: string;
  tokenEstimate: number;
  createdAt: string;
  metadata: Record<string, unknown>;
  lineage: RetrievalLineage;
  sourceMessageRange?: RetrievalSourceMessageRange;
};

/**
 * File describe payload.
 */
export type RetrievalFileDescribeResult = {
  id: string;
  kind: "file";
  conversationId: ConversationId;
  path: string;
  fileName?: string;
  mimeType?: string;
  bytes?: number;
  sha256?: string;
  createdAt: string;
  metadata: Record<string, unknown>;
  relatedMessageId?: MessageId;
};

/**
 * Describe query output for retrieval introspection.
 */
export type RetrievalDescribeResult = RetrievalSummaryDescribeResult | RetrievalFileDescribeResult;

/**
 * Grep query input.
 */
export type RetrievalGrepInput = {
  query: string;
  mode?: RetrievalGrepMode;
  scope?: RetrievalGrepScope;
  conversationId?: ConversationId;
  limit?: number;
};

/**
 * Individual grep hit.
 */
export type RetrievalGrepMatch = {
  id: string;
  kind: "message" | "summary";
  conversationId: ConversationId;
  snippet: string;
  createdAt: string;
  score?: number;
};

/**
 * Grep query output.
 */
export type RetrievalGrepResult = {
  query: string;
  mode: RetrievalGrepMode;
  scope: RetrievalGrepScope;
  matches: RetrievalGrepMatch[];
  truncated: boolean;
  scannedCount: number;
};

/**
 * Summary expansion query input.
 */
export type RetrievalExpandInput = {
  summaryId: SummaryId;
  depth?: number;
  includeMessages?: boolean;
  tokenCap?: number;
  limit?: number;
};

/**
 * Summary item returned from expansion traversal.
 */
export type RetrievalExpandedSummary = {
  id: SummaryId;
  conversationId: ConversationId;
  title?: string;
  body: string;
  depth: number;
  createdAt: string;
  tokenEstimate: number;
};

/**
 * Message item returned from expansion traversal.
 */
export type RetrievalExpandedMessage = {
  id: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  content: string;
  depth: number;
  createdAt: string;
  tokenEstimate: number;
};

/**
 * Expansion output payload.
 */
export type RetrievalExpandResult = {
  rootSummaryId: SummaryId;
  conversationId: ConversationId;
  summaries: RetrievalExpandedSummary[];
  messages: RetrievalExpandedMessage[];
  estimatedTokens: number;
  truncated: boolean;
  nextSummaryIds: SummaryId[];
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
  describe(id: string): Promise<RetrievalDescribeResult | null>;
  grep(input: RetrievalGrepInput): Promise<RetrievalGrepResult>;
  expand(input: RetrievalExpandInput): Promise<RetrievalExpandResult>;
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
