import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
} from "../../context-engine/types.js";
import { getLcmConnection, closeLcmConnection } from "./db/connection.js";
import { runLcmMigrations } from "./db/migration.js";
import { resolveLcmConfig, type LcmConfig } from "./db/config.js";
import { ConversationStore } from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import { ContextAssembler } from "./assembler.js";
import { CompactionEngine, type CompactionConfig } from "./compaction.js";
import { RetrievalEngine } from "./retrieval.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Map AgentMessage role to the DB enum.
 *
 *   "user"      -> "user"
 *   "assistant" -> "assistant"
 *
 * AgentMessage only has user/assistant roles, but we keep the mapping
 * explicit for clarity and future-proofing.
 */
function toDbRole(role: string): "user" | "assistant" | "system" | "tool" {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  // Fallback — shouldn't happen with AgentMessage, but safe default
  return "user";
}

// ── LcmContextEngine ────────────────────────────────────────────────────────

export class LcmContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "lcm",
    name: "Lossless Context Management Engine",
    version: "0.1.0",
  };

  private config: LcmConfig;
  private conversationStore: ConversationStore;
  private summaryStore: SummaryStore;
  private assembler: ContextAssembler;
  private compaction: CompactionEngine;
  private retrieval: RetrievalEngine;
  private migrated = false;

  constructor(config?: LcmConfig) {
    this.config = config ?? resolveLcmConfig();

    const db = getLcmConnection(this.config.databasePath);

    this.conversationStore = new ConversationStore(db);
    this.summaryStore = new SummaryStore(db);

    this.assembler = new ContextAssembler(
      this.conversationStore,
      this.summaryStore,
    );

    const compactionConfig: CompactionConfig = {
      contextThreshold: this.config.contextThreshold,
      freshTailCount: this.config.freshTailCount,
      leafTargetTokens: this.config.leafTargetTokens,
      condensedTargetTokens: this.config.condensedTargetTokens,
      maxRounds: 10,
    };
    this.compaction = new CompactionEngine(
      this.conversationStore,
      this.summaryStore,
      compactionConfig,
    );

    this.retrieval = new RetrievalEngine(
      this.conversationStore,
      this.summaryStore,
    );
  }

  /** Ensure DB schema is up-to-date. Called lazily on first ingest/assemble/compact. */
  private ensureMigrated(): void {
    if (this.migrated) return;
    const db = getLcmConnection(this.config.databasePath);
    runLcmMigrations(db);
    this.migrated = true;
  }

  // ── ContextEngine interface ─────────────────────────────────────────────

  async ingest(params: {
    sessionId: string;
    message: AgentMessage;
  }): Promise<IngestResult> {
    this.ensureMigrated();

    const { sessionId, message } = params;
    const content =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);

    // Get or create conversation for this session
    const conversation =
      await this.conversationStore.getOrCreateConversation(sessionId);
    const conversationId = conversation.conversationId;

    // Determine next sequence number
    const maxSeq = await this.conversationStore.getMaxSeq(conversationId);
    const seq = maxSeq + 1;

    // Persist the message
    const msgRecord = await this.conversationStore.createMessage({
      conversationId,
      seq,
      role: toDbRole(message.role),
      content,
      tokenCount: estimateTokens(content),
    });

    // Append to context items so assembler can see it
    await this.summaryStore.appendContextMessage(
      conversationId,
      msgRecord.messageId,
    );

    return { ingested: true };
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    this.ensureMigrated();

    const { sessionId, tokenBudget } = params;

    // Look up conversation — if none exists, fall back to pass-through
    const conversation =
      await this.conversationStore.getConversationBySessionId(sessionId);
    if (!conversation) {
      return {
        messages: params.messages,
        estimatedTokens: 0,
      };
    }

    const budget = tokenBudget ?? 128_000; // default to 128k if unspecified

    const result = await this.assembler.assemble({
      conversationId: conversation.conversationId,
      tokenBudget: budget,
      freshTailCount: this.config.freshTailCount,
    });

    return {
      messages: result.messages,
      estimatedTokens: result.estimatedTokens,
    };
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    customInstructions?: string;
    legacyParams?: Record<string, unknown>;
  }): Promise<CompactResult> {
    this.ensureMigrated();

    const { sessionId } = params;

    // Look up conversation
    const conversation =
      await this.conversationStore.getConversationBySessionId(sessionId);
    if (!conversation) {
      return {
        ok: true,
        compacted: false,
        reason: "no conversation found for session",
      };
    }

    const conversationId = conversation.conversationId;

    // Extract summarize callback from legacyParams if provided,
    // otherwise use a built-in placeholder that delegates to the
    // LLM provider (will be wired in the runtime integration task).
    const lp = params.legacyParams ?? {};
    const summarize: (text: string, aggressive?: boolean) => Promise<string> =
      typeof lp.summarize === "function"
        ? (lp.summarize as (text: string, aggressive?: boolean) => Promise<string>)
        : createDefaultSummarize(params.customInstructions);

    // Determine token budget from legacyParams or use a sensible default
    const tokenBudget =
      typeof lp.tokenBudget === "number" ? lp.tokenBudget : 128_000;

    // Evaluate whether compaction is needed
    const decision = await this.compaction.evaluate(
      conversationId,
      tokenBudget,
    );

    if (!decision.shouldCompact) {
      return {
        ok: true,
        compacted: false,
        reason: "below threshold",
        result: {
          tokensBefore: decision.currentTokens,
        },
      };
    }

    // Run compaction until under budget
    const compactResult = await this.compaction.compactUntilUnder({
      conversationId,
      tokenBudget,
      summarize,
    });

    return {
      ok: compactResult.success,
      compacted: compactResult.rounds > 0,
      reason: compactResult.success ? "compacted" : "could not reach target",
      result: {
        tokensBefore: decision.currentTokens,
        tokensAfter: compactResult.finalTokens,
        details: {
          rounds: compactResult.rounds,
        },
      },
    };
  }

  async dispose(): Promise<void> {
    closeLcmConnection();
  }

  // ── Public accessors for retrieval (used by subagent expansion) ─────────

  getRetrieval(): RetrievalEngine {
    return this.retrieval;
  }

  getConversationStore(): ConversationStore {
    return this.conversationStore;
  }

  getSummaryStore(): SummaryStore {
    return this.summaryStore;
  }
}

// ── Default summarization stub ──────────────────────────────────────────────

/**
 * Creates a default summarization function that produces a simple truncation.
 *
 * This is a placeholder until the runtime integration wires in the real
 * LLM-powered summarization. The real implementation will call the
 * configured provider with appropriate prompts for normal vs aggressive mode.
 */
function createDefaultSummarize(
  _customInstructions?: string,
): (text: string, aggressive?: boolean) => Promise<string> {
  return async (text: string, aggressive?: boolean): Promise<string> => {
    // Placeholder: truncate to target size.
    // The real implementation will be an LLM call injected via legacyParams.summarize
    // or wired through the provider system in the runtime integration task.
    const maxChars = aggressive ? 600 * 4 : 900 * 4;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "\n[Truncated for context management]";
  };
}
