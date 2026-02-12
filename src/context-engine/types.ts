import type { AgentMessage } from "@mariozechner/pi-agent-core";

// =============================================================================
// Ingest
// =============================================================================

/**
 * Parameters for the ingest phase: normalize raw message history into a
 * clean, provider-agnostic form suitable for assembly.
 */
export type ContextIngestParams = {
  /** Raw conversation messages loaded from the session transcript. */
  messages: AgentMessage[];
  /** Identifier of the model provider (e.g. "anthropic", "google"). */
  provider: string;
  /** Model identifier (e.g. "claude-sonnet-4-5-20250929"). */
  modelId: string;
  /** Unique session identifier. */
  sessionId: string;
  /** Opaque metadata the engine can thread through the pipeline. */
  meta?: Record<string, unknown>;
};

/**
 * Result of the ingest phase.
 */
export type ContextIngestResult = {
  /** Cleaned, normalized messages ready for assembly. */
  messages: AgentMessage[];
  /** Opaque metadata propagated downstream. */
  meta?: Record<string, unknown>;
};

// =============================================================================
// Assemble
// =============================================================================

/**
 * Parameters for the assemble phase: produce the final message list
 * that will be sent to the model, applying truncation and enrichment.
 */
export type ContextAssembleParams = {
  /** Pre-ingested (normalized) messages. */
  messages: AgentMessage[];
  /** Maximum number of user turns to retain (undefined = no limit). */
  historyTurnLimit?: number;
  /** Opaque metadata from a prior ingest result. */
  meta?: Record<string, unknown>;
};

/**
 * Result of the assemble phase.
 */
export type ContextAssembleResult = {
  /** Final message list ready for submission to the model. */
  messages: AgentMessage[];
  /** Opaque metadata propagated downstream. */
  meta?: Record<string, unknown>;
};

// =============================================================================
// Compact
// =============================================================================

/**
 * Parameters for the compact phase: reduce context size via summarization
 * or other lossy transformations.
 */
export type ContextCompactParams = {
  /** Current conversation messages. */
  messages: AgentMessage[];
  /** Optional free-form instructions to guide compaction (e.g. user hints). */
  customInstructions?: string;
  /** Opaque metadata from the pipeline. */
  meta?: Record<string, unknown>;
};

/**
 * Result of the compact phase.
 */
export type ContextCompactResult = {
  /** Whether compaction completed successfully. */
  ok: boolean;
  /** Whether the context was actually reduced (false when already small enough). */
  compacted: boolean;
  /** Human-readable explanation when compaction is skipped or fails. */
  reason?: string;
  /** Details available on success. */
  result?: {
    /** Generated summary text. */
    summary: string;
    /** Identifier of the first message retained after compaction. */
    firstKeptEntryId: string;
    /** Token count before compaction. */
    tokensBefore: number;
    /** Token count after compaction (when estimable). */
    tokensAfter?: number;
    /** Engine-specific details. */
    details?: unknown;
  };
};

// =============================================================================
// ContextEngine interface
// =============================================================================

/**
 * A ContextEngine manages the three phases of conversation context lifecycle:
 *
 * 1. **ingest** — Normalize raw session history into a clean form.
 * 2. **assemble** — Produce the final context window for the model.
 * 3. **compact** — Reduce context size when it exceeds capacity.
 *
 * Implementations are provider-agnostic: the interface captures the behavioral
 * contract without prescribing retrieval, lineage, or expansion strategies.
 */
export type ContextEngine = {
  /** Unique identifier for this engine (matches the config/slot value). */
  readonly id: string;

  /**
   * Normalize raw messages from the session transcript.
   *
   * Typical responsibilities: encoding normalization, tool-call repair,
   * provider-specific fixups, content sanitization.
   */
  ingest(params: ContextIngestParams): Promise<ContextIngestResult>;

  /**
   * Assemble the final message list for the model.
   *
   * Typical responsibilities: history truncation, content enrichment,
   * token budgeting, image injection.
   */
  assemble(params: ContextAssembleParams): Promise<ContextAssembleResult>;

  /**
   * Reduce context size via summarization or other lossy transformation.
   *
   * Typical responsibilities: LLM-driven summarization, message pruning,
   * token estimation before/after.
   */
  compact(params: ContextCompactParams): Promise<ContextCompactResult>;
};
