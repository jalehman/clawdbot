import type { AgentMessage } from "@mariozechner/pi-agent-core";

// Result types

export type AssembleResult = {
  /** Ordered messages to use as model context */
  messages: AgentMessage[];
  /** Estimated total tokens in assembled context */
  estimatedTokens: number;
};

export type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
};

export type IngestResult = {
  /** Whether the message was ingested (false if duplicate or no-op) */
  ingested: boolean;
};

export type BootstrapResult = {
  /** Whether bootstrap imported historical context into the canonical store */
  bootstrapped: boolean;
  /** Number of imported historical messages when bootstrap ran */
  importedMessages?: number;
  /** Optional reason when bootstrap did not import */
  reason?: string;
};

export type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string;
};

/**
 * ContextEngine defines the pluggable contract for context management.
 *
 * Required methods are neutral (no LCM-specific semantics).
 * Optional methods (retrieval, lineage) can be provided by specific engines.
 */
export interface ContextEngine {
  /** Engine identifier and metadata */
  readonly info: ContextEngineInfo;

  /**
   * Bootstrap historical session context into the canonical store.
   * Engines that don't own persistence (legacy) can omit this.
   */
  bootstrap?(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult>;

  /**
   * Ingest a message into the canonical store.
   * For legacy engine, this is a no-op (messages are managed by SessionManager).
   */
  ingest(params: { sessionId: string; message: AgentMessage }): Promise<IngestResult>;

  /**
   * Assemble model context under a token budget.
   * Returns an ordered set of messages ready for the model.
   */
  assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult>;

  /**
   * Compact context to reduce token usage.
   * May create summaries, prune old turns, etc.
   */
  compact(params: {
    sessionId: string;
    sessionFile: string;
    customInstructions?: string;
    /** Full params needed for legacy compaction behavior */
    legacyParams?: Record<string, unknown>;
  }): Promise<CompactResult>;

  /**
   * Dispose of any resources held by the engine.
   */
  dispose?(): Promise<void>;
}
