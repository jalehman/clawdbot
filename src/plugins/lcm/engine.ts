import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  BootstrapResult,
  CompactResult,
  IngestResult,
} from "../../context-engine/types.js";
import { ContextAssembler } from "./assembler.js";
import { CompactionEngine, type CompactionConfig } from "./compaction.js";
import { resolveLcmConfig, type LcmConfig } from "./db/config.js";
import { getLcmConnection, closeLcmConnection } from "./db/connection.js";
import { runLcmMigrations } from "./db/migration.js";
import { RetrievalEngine } from "./retrieval.js";
import { ConversationStore } from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Convert AgentMessage content into plain text for DB storage.
 *
 * For content block arrays we keep only text blocks to avoid persisting raw
 * JSON syntax that can later pollute assembled model context.
 */
function extractMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type?: unknown; text?: unknown } => {
        return !!block && typeof block === "object";
      })
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
  }

  const serialized = JSON.stringify(content);
  return typeof serialized === "string" ? serialized : "";
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
  if (role === "user") {
    return "user";
  }
  if (role === "assistant") {
    return "assistant";
  }
  // Fallback — shouldn't happen with AgentMessage, but safe default
  return "user";
}

type StoredMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tokenCount: number;
};

/**
 * Normalize AgentMessage variants into the storage shape used by LCM.
 */
function toStoredMessage(message: AgentMessage): StoredMessage {
  const content =
    "content" in message
      ? extractMessageContent(message.content)
      : "output" in message
        ? `$ ${(message as { command: string; output: string }).command}\n${(message as { command: string; output: string }).output}`
        : "";

  return {
    role: toDbRole(message.role),
    content,
    tokenCount: estimateTokens(content),
  };
}

function isBootstrapMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const msg = value as { role?: unknown; content?: unknown; command?: unknown; output?: unknown };
  if (typeof msg.role !== "string") {
    return false;
  }
  return "content" in msg || ("command" in msg && "output" in msg);
}

/**
 * Load the active leaf-path context from a session file using SessionManager
 * semantics (open + buildSessionContext).
 */
function readLeafPathMessages(sessionFile: string): AgentMessage[] {
  const sessionManager = SessionManager.open(sessionFile) as unknown as {
    setSessionFile?: (path: string) => void;
    buildSessionContext?: () => { messages?: unknown };
  };
  sessionManager.setSessionFile?.(sessionFile);
  const context = sessionManager.buildSessionContext?.();
  const messages = context?.messages;
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.filter(isBootstrapMessage);
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

    this.assembler = new ContextAssembler(this.conversationStore, this.summaryStore);

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

    this.retrieval = new RetrievalEngine(this.conversationStore, this.summaryStore);
  }

  /** Ensure DB schema is up-to-date. Called lazily on first bootstrap/ingest/assemble/compact. */
  private ensureMigrated(): void {
    if (this.migrated) {
      return;
    }
    const db = getLcmConnection(this.config.databasePath);
    runLcmMigrations(db);
    this.migrated = true;
  }

  // ── ContextEngine interface ─────────────────────────────────────────────

  async bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
    this.ensureMigrated();

    return this.conversationStore.withTransaction(async () => {
      const conversation = await this.conversationStore.getOrCreateConversation(params.sessionId);
      const conversationId = conversation.conversationId;

      if (conversation.bootstrappedAt) {
        return {
          bootstrapped: false,
          importedMessages: 0,
          reason: "already bootstrapped",
        };
      }

      // If data already exists but bootstrap marker was never written (for example
      // from a partial deploy), avoid re-importing duplicates and just seal state.
      const existingCount = await this.conversationStore.getMessageCount(conversationId);
      if (existingCount > 0) {
        await this.conversationStore.markConversationBootstrapped(conversationId);
        return {
          bootstrapped: false,
          importedMessages: 0,
          reason: "conversation already has messages",
        };
      }

      const historicalMessages = readLeafPathMessages(params.sessionFile);
      if (historicalMessages.length === 0) {
        await this.conversationStore.markConversationBootstrapped(conversationId);
        return {
          bootstrapped: false,
          importedMessages: 0,
          reason: "no leaf-path messages in session",
        };
      }

      const nextSeq = (await this.conversationStore.getMaxSeq(conversationId)) + 1;
      const bulkInput = historicalMessages.map((message, index) => {
        const stored = toStoredMessage(message);
        return {
          conversationId,
          seq: nextSeq + index,
          role: stored.role,
          content: stored.content,
          tokenCount: stored.tokenCount,
        };
      });

      const inserted = await this.conversationStore.createMessagesBulk(bulkInput);
      await this.summaryStore.appendContextMessages(
        conversationId,
        inserted.map((record) => record.messageId),
      );
      await this.conversationStore.markConversationBootstrapped(conversationId);

      return {
        bootstrapped: true,
        importedMessages: inserted.length,
      };
    });
  }

  async ingest(params: { sessionId: string; message: AgentMessage }): Promise<IngestResult> {
    this.ensureMigrated();

    const { sessionId, message } = params;
    const stored = toStoredMessage(message);

    // Get or create conversation for this session
    const conversation = await this.conversationStore.getOrCreateConversation(sessionId);
    const conversationId = conversation.conversationId;

    // Determine next sequence number
    const maxSeq = await this.conversationStore.getMaxSeq(conversationId);
    const seq = maxSeq + 1;

    // Persist the message
    const msgRecord = await this.conversationStore.createMessage({
      conversationId,
      seq,
      role: stored.role,
      content: stored.content,
      tokenCount: stored.tokenCount,
    });

    // Append to context items so assembler can see it
    await this.summaryStore.appendContextMessage(conversationId, msgRecord.messageId);

    return { ingested: true };
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    this.ensureMigrated();

    // Pass through the live session messages unchanged.
    // LCM ingest currently runs post-prompt and does not capture the full
    // live context (for example system prompts and pre-prompt session history).
    // Replacing active session messages with DB-assembled context causes
    // context loss across turns.
    return {
      messages: params.messages,
      estimatedTokens: 0,
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
    const conversation = await this.conversationStore.getConversationBySessionId(sessionId);
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
    const tokenBudget = typeof lp.tokenBudget === "number" ? lp.tokenBudget : 128_000;

    // Evaluate whether compaction is needed
    const decision = await this.compaction.evaluate(conversationId, tokenBudget);

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
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, maxChars) + "\n[Truncated for context management]";
  };
}
