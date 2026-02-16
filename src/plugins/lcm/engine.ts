import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  BootstrapResult,
  CompactResult,
  IngestBatchResult,
  IngestResult,
} from "../../context-engine/types.js";
import { ContextAssembler } from "./assembler.js";
import { CompactionEngine, type CompactionConfig } from "./compaction.js";
import { resolveLcmConfig, type LcmConfig } from "./db/config.js";
import { getLcmConnection, closeLcmConnection } from "./db/connection.js";
import { runLcmMigrations } from "./db/migration.js";
import { RetrievalEngine } from "./retrieval.js";
import {
  ConversationStore,
  type CreateMessagePartInput,
  type MessagePartType,
} from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import { createLcmSummarizeFromLegacyParams } from "./summarize.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function toJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : "";
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeUnknownBlock(value: unknown): {
  type: string;
  text?: string;
  metadata: Record<string, unknown>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      type: "agent",
      metadata: { raw: value },
    };
  }

  const record = value as Record<string, unknown>;
  const rawType = safeString(record.type);
  return {
    type: rawType ?? "agent",
    text: safeString(record.text) ?? safeString(record.thinking),
    metadata: { raw: record },
  };
}

function toPartType(type: string): MessagePartType {
  switch (type) {
    case "text":
      return "text";
    case "thinking":
    case "reasoning":
      return "reasoning";
    case "tool_use":
    case "tool-use":
    case "tool_result":
    case "toolResult":
    case "tool":
      return "tool";
    case "patch":
      return "patch";
    case "file":
    case "image":
      return "file";
    case "subtask":
      return "subtask";
    case "compaction":
      return "compaction";
    case "step_start":
    case "step-start":
      return "step_start";
    case "step_finish":
    case "step-finish":
      return "step_finish";
    case "snapshot":
      return "snapshot";
    case "retry":
      return "retry";
    case "agent":
      return "agent";
    default:
      return "agent";
  }
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

function toRuntimeRoleForTokenEstimate(role: string): "user" | "assistant" | "toolResult" {
  if (role === "tool" || role === "toolResult") {
    return "toolResult";
  }
  if (role === "user" || role === "system") {
    return "user";
  }
  return "assistant";
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string";
}

/**
 * Estimate token usage for the content shape that the assembler will emit.
 *
 * LCM stores a plain-text fallback copy in messages.content, but message_parts
 * can rehydrate larger structured/raw blocks. This estimator mirrors the
 * rehydrated shape so compaction decisions use realistic token totals.
 */
function estimateContentTokensForRole(params: {
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  fallbackContent: string;
}): number {
  const { role, content, fallbackContent } = params;

  if (typeof content === "string") {
    return estimateTokens(content);
  }

  if (Array.isArray(content)) {
    if (content.length === 0) {
      return estimateTokens(fallbackContent);
    }

    if (role === "user" && content.length === 1 && isTextBlock(content[0])) {
      return estimateTokens(content[0].text);
    }

    const serialized = JSON.stringify(content);
    return estimateTokens(typeof serialized === "string" ? serialized : "");
  }

  if (content && typeof content === "object") {
    if (role === "user" && isTextBlock(content)) {
      return estimateTokens(content.text);
    }

    const serialized = JSON.stringify([content]);
    return estimateTokens(typeof serialized === "string" ? serialized : "");
  }

  return estimateTokens(fallbackContent);
}

function buildMessageParts(params: {
  sessionId: string;
  message: AgentMessage;
  fallbackContent: string;
}): import("./store/conversation-store.js").CreateMessagePartInput[] {
  const { sessionId, message, fallbackContent } = params;
  const role = typeof message.role === "string" ? message.role : "unknown";
  const topLevel = message as unknown as Record<string, unknown>;
  const topLevelToolCallId =
    safeString(topLevel.toolCallId) ?? safeString(topLevel.tool_call_id) ?? safeString(topLevel.id);

  // BashExecutionMessage: preserve a synthetic text part so output is round-trippable.
  if (!("content" in message) && "command" in message && "output" in message) {
    return [
      {
        sessionId,
        partType: "text",
        ordinal: 0,
        textContent: fallbackContent,
        metadata: toJson({
          originalRole: role,
          source: "bash-exec",
          command: safeString((message as { command?: unknown }).command),
        }),
      },
    ];
  }

  if (!("content" in message)) {
    return [
      {
        sessionId,
        partType: "agent",
        ordinal: 0,
        textContent: fallbackContent || null,
        metadata: toJson({
          originalRole: role,
          source: "unknown-message-shape",
          raw: message,
        }),
      },
    ];
  }

  if (typeof message.content === "string") {
    return [
      {
        sessionId,
        partType: "text",
        ordinal: 0,
        textContent: message.content,
        metadata: toJson({
          originalRole: role,
        }),
      },
    ];
  }

  if (!Array.isArray(message.content)) {
    return [
      {
        sessionId,
        partType: "agent",
        ordinal: 0,
        textContent: fallbackContent || null,
        metadata: toJson({
          originalRole: role,
          source: "non-array-content",
          raw: message.content,
        }),
      },
    ];
  }

  const parts: CreateMessagePartInput[] = [];
  for (let ordinal = 0; ordinal < message.content.length; ordinal++) {
    const block = normalizeUnknownBlock(message.content[ordinal]);
    const metadataRecord = block.metadata.raw as Record<string, unknown> | undefined;
    const toolCallId =
      safeString(metadataRecord?.toolCallId) ??
      safeString(metadataRecord?.tool_call_id) ??
      topLevelToolCallId;

    parts.push({
      sessionId,
      partType: toPartType(block.type),
      ordinal,
      textContent: block.text ?? null,
      toolCallId,
      toolName:
        safeString(metadataRecord?.name) ??
        safeString(metadataRecord?.toolName) ??
        safeString(metadataRecord?.tool_name),
      toolInput:
        metadataRecord?.input !== undefined
          ? toJson(metadataRecord.input)
          : metadataRecord?.toolInput !== undefined
            ? toJson(metadataRecord.toolInput)
            : (safeString(metadataRecord?.tool_input) ?? null),
      toolOutput:
        metadataRecord?.output !== undefined
          ? toJson(metadataRecord.output)
          : metadataRecord?.toolOutput !== undefined
            ? toJson(metadataRecord.toolOutput)
            : (safeString(metadataRecord?.tool_output) ?? null),
      metadata: toJson({
        originalRole: role,
        rawType: block.type,
        raw: metadataRecord ?? message.content[ordinal],
      }),
    });
  }

  return parts;
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
  if (role === "tool" || role === "toolResult") {
    return "tool";
  }
  if (role === "system") {
    return "system";
  }
  if (role === "user") {
    return "user";
  }
  if (role === "assistant") {
    return "assistant";
  }
  // Unknown roles are preserved via message_parts metadata and treated as assistant.
  return "assistant";
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
  const runtimeRole = toRuntimeRoleForTokenEstimate(message.role);
  const tokenCount =
    "content" in message
      ? estimateContentTokensForRole({
          role: runtimeRole,
          content: message.content,
          fallbackContent: content,
        })
      : estimateTokens(content);

  return {
    role: toDbRole(message.role),
    content,
    tokenCount,
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
  private sessionOperationQueues = new Map<string, Promise<void>>();

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

  /**
   * Serialize mutating operations per session to prevent ingest/compaction races.
   */
  private async withSessionQueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperationQueues.get(sessionId) ?? Promise.resolve();
    let releaseQueue: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const next = previous.catch(() => {}).then(() => current);
    this.sessionOperationQueues.set(sessionId, next);

    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      releaseQueue();
      void next.finally(() => {
        if (this.sessionOperationQueues.get(sessionId) === next) {
          this.sessionOperationQueues.delete(sessionId);
        }
      });
    }
  }

  /** Normalize optional live token estimates supplied by runtime callers. */
  private normalizeObservedTokenCount(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.floor(value);
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

  private async ingestSingle(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    const { sessionId, message, isHeartbeat } = params;
    if (isHeartbeat) {
      return { ingested: false };
    }
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
    await this.conversationStore.createMessageParts(
      msgRecord.messageId,
      buildMessageParts({
        sessionId,
        message,
        fallbackContent: stored.content,
      }),
    );

    // Append to context items so assembler can see it
    await this.summaryStore.appendContextMessage(conversationId, msgRecord.messageId);

    return { ingested: true };
  }

  async ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    this.ensureMigrated();
    return this.withSessionQueue(params.sessionId, () => this.ingestSingle(params));
  }

  async ingestBatch(params: {
    sessionId: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult> {
    this.ensureMigrated();
    if (params.messages.length === 0) {
      return { ingestedCount: 0 };
    }
    return this.withSessionQueue(params.sessionId, async () => {
      let ingestedCount = 0;
      for (const message of params.messages) {
        const result = await this.ingestSingle({
          sessionId: params.sessionId,
          message,
          isHeartbeat: params.isHeartbeat,
        });
        if (result.ingested) {
          ingestedCount += 1;
        }
      }
      return { ingestedCount };
    });
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    try {
      this.ensureMigrated();

      const conversation = await this.conversationStore.getConversationBySessionId(
        params.sessionId,
      );
      if (!conversation) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      const contextItems = await this.summaryStore.getContextItems(conversation.conversationId);
      if (contextItems.length === 0) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      // Guard against incomplete bootstrap/coverage: if the DB only has
      // raw context items and clearly trails the current live history, keep
      // the live path to avoid dropping prompt context.
      const hasSummaryItems = contextItems.some((item) => item.itemType === "summary");
      if (!hasSummaryItems && contextItems.length < params.messages.length) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      const tokenBudget =
        typeof params.tokenBudget === "number" &&
        Number.isFinite(params.tokenBudget) &&
        params.tokenBudget > 0
          ? Math.floor(params.tokenBudget)
          : 128_000;

      const assembled = await this.assembler.assemble({
        conversationId: conversation.conversationId,
        tokenBudget,
        freshTailCount: this.config.freshTailCount,
      });

      // If assembly produced no messages for a non-empty live session,
      // fail safe to the live context.
      if (assembled.messages.length === 0 && params.messages.length > 0) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      return {
        messages: assembled.messages,
        estimatedTokens: assembled.estimatedTokens,
      };
    } catch {
      return {
        messages: params.messages,
        estimatedTokens: 0,
      };
    }
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    legacyParams?: Record<string, unknown>;
    /** Force compaction even if below threshold */
    force?: boolean;
  }): Promise<CompactResult> {
    this.ensureMigrated();
    return this.withSessionQueue(params.sessionId, async () => {
      const { sessionId, force = false } = params;

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

      const lp = params.legacyParams ?? {};
      const manualCompactionRequested =
        (
          lp as {
            manualCompaction?: unknown;
          }
        ).manualCompaction === true;
      const forceCompaction = force || manualCompactionRequested;
      const tokenBudget =
        typeof params.tokenBudget === "number" &&
        Number.isFinite(params.tokenBudget) &&
        params.tokenBudget > 0
          ? Math.floor(params.tokenBudget)
          : typeof lp.tokenBudget === "number" &&
              Number.isFinite(lp.tokenBudget) &&
              lp.tokenBudget > 0
            ? Math.floor(lp.tokenBudget)
            : undefined;
      if (!tokenBudget) {
        return {
          ok: false,
          compacted: false,
          reason: "missing token budget in compact params",
        };
      }

      // 1) Honor an explicitly injected summarize callback.
      // 2) Try model-backed summarization from runtime provider/model params.
      // 3) Fall back to deterministic truncation only if summarizer setup fails.
      const summarize = await (async (): Promise<
        (text: string, aggressive?: boolean) => Promise<string>
      > => {
        if (typeof lp.summarize === "function") {
          return lp.summarize as (text: string, aggressive?: boolean) => Promise<string>;
        }
        try {
          const runtimeSummarizer = await createLcmSummarizeFromLegacyParams({
            legacyParams: lp,
            customInstructions: params.customInstructions,
          });
          if (runtimeSummarizer) {
            return runtimeSummarizer;
          }
        } catch {
          // Preserve compaction behavior even when model-backed setup fails.
        }
        return createEmergencyFallbackSummarize();
      })();

      // Evaluate whether compaction is needed (unless forced)
      const observedTokens = this.normalizeObservedTokenCount(
        params.currentTokenCount ??
          (
            lp as {
              currentTokenCount?: unknown;
            }
          ).currentTokenCount,
      );
      const decision =
        observedTokens !== undefined
          ? await this.compaction.evaluate(conversationId, tokenBudget, observedTokens)
          : await this.compaction.evaluate(conversationId, tokenBudget);

      if (!forceCompaction && !decision.shouldCompact) {
        return {
          ok: true,
          compacted: false,
          reason: "below threshold",
          result: {
            tokensBefore: decision.currentTokens,
          },
        };
      }

      if (manualCompactionRequested) {
        const forcedRound = await this.compaction.compact({
          conversationId,
          tokenBudget,
          summarize,
          force: true,
        });

        return {
          ok: true,
          compacted: forcedRound.actionTaken,
          reason: forcedRound.actionTaken ? "compacted" : "nothing to compact",
          result: {
            tokensBefore: decision.currentTokens,
            tokensAfter: forcedRound.tokensAfter,
            details: {
              rounds: forcedRound.actionTaken ? 1 : 0,
              targetTokens: tokenBudget,
            },
          },
        };
      }

      // When forced, use the token budget as target
      const targetTokens = forceCompaction
        ? tokenBudget
        : params.compactionTarget === "threshold"
          ? decision.threshold
          : tokenBudget;

      const compactResult = await this.compaction.compactUntilUnder({
        conversationId,
        tokenBudget,
        targetTokens,
        ...(observedTokens !== undefined ? { currentTokens: observedTokens } : {}),
        summarize,
      });
      const didCompact = compactResult.rounds > 0;

      return {
        ok: compactResult.success,
        compacted: didCompact,
        reason: compactResult.success
          ? didCompact
            ? "compacted"
            : "already under target"
          : "could not reach target",
        result: {
          tokensBefore: decision.currentTokens,
          tokensAfter: compactResult.finalTokens,
          details: {
            rounds: compactResult.rounds,
            targetTokens,
          },
        },
      };
    });
  }

  async dispose(): Promise<void> {
    closeLcmConnection(this.config.databasePath);
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

// ── Emergency fallback summarization ────────────────────────────────────────

/**
 * Creates a deterministic truncation summarizer used only as an emergency
 * fallback when the model-backed summarizer cannot be created.
 *
 * CompactionEngine already escalates normal -> aggressive -> fallback for
 * convergence. This function simply provides a stable baseline summarize
 * callback to keep compaction operable when runtime setup is unavailable.
 */
function createEmergencyFallbackSummarize(): (
  text: string,
  aggressive?: boolean,
) => Promise<string> {
  return async (text: string, aggressive?: boolean): Promise<string> => {
    const maxChars = aggressive ? 600 * 4 : 900 * 4;
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, maxChars) + "\n[Truncated for context management]";
  };
}
