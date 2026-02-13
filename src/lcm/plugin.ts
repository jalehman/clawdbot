import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { OpenClawPluginDefinition } from "../plugins/types.js";
import type {
  ConversationId,
  LcmMessage,
  LcmRuntime,
  LcmSummary,
  RetrievalExpandInput,
  RetrievalGrepInput,
} from "./types.js";
import { AGENT_LANE_SUBAGENT } from "../agents/lanes.js";
import { buildSubagentSystemPrompt } from "../agents/subagent-announce.js";
import { readLatestAssistantReply } from "../agents/tools/agent-step.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../agents/tools/sessions-helpers.js";
import { resolveStateDir } from "../config/paths.js";
import {
  registerContextEngine,
  registeredContextEngineIds,
  type ContextCompactParams,
  type ContextEngine,
} from "../context-engine/index.js";
import { callGateway } from "../gateway/call.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { createCompactionEngine } from "./compaction-engine.js";
import { LCM_PLUGIN_CONFIG_SCHEMA, resolveLcmConfig, type LcmConfig } from "./config.js";
import { createContextAssembler } from "./context-assembler.js";
import { createConversationStore } from "./conversation-store.js";
import { ingestCanonicalTranscript, resolveConversationId } from "./ingestion.js";
import { createLcmIntegrityChecker } from "./integrity-checker.js";
import { createLcmMetrics } from "./observability.js";
import { createLcmRetrievalEngine } from "./retrieval-engine.js";
import { createLcmStorageBackend } from "./storage/backend.js";
import {
  SubagentExpansionOrchestrator,
  type SubagentExpansionRunner,
} from "./subagent-expansion.js";
import { createPlaceholderTokenEstimator } from "./token-estimator.js";

/**
 * Canonical id for the scaffolded LCM engine.
 */
export const LCM_CONTEXT_ENGINE_ID = "lcm";

type LcmPluginRuntime = LcmRuntime & {
  ensureReady: () => Promise<void>;
};

function createScaffoldRuntime(logMetrics?: (message: string) => void): LcmPluginRuntime {
  const storage = createLcmStorageBackend({
    sqlite: {
      dbPath: path.join(resolveStateDir(), "lcm", "lcm.sqlite"),
    },
  });
  const tokenEstimator = createPlaceholderTokenEstimator();
  const store = createConversationStore({ storage });
  const metrics = createLcmMetrics({
    onEvent(event) {
      if (!logMetrics) {
        return;
      }
      logMetrics(`lcm.metrics ${JSON.stringify(event)}`);
    },
    historyLimit: 100,
  });
  let readyPromise: Promise<void> | null = null;
  return {
    store,
    assembler: createContextAssembler({
      store,
      tokenEstimator,
    }),
    compaction: createCompactionEngine({
      store,
      tokenEstimator,
      metrics,
    }),
    retrieval: createLcmRetrievalEngine({
      backend: storage,
      tokenEstimator,
      metrics,
    }),
    integrity: createLcmIntegrityChecker({
      backend: storage,
      metrics,
    }),
    ensureReady() {
      if (!readyPromise) {
        readyPromise = storage.migrate();
      }
      return readyPromise;
    },
  };
}

/**
 * Build an LCM context engine with canonical ingest persistence.
 */
function createLcmContextEngine(runtime: LcmPluginRuntime, lcmConfig: LcmConfig): ContextEngine {
  const tokenEstimator = createPlaceholderTokenEstimator();
  return {
    id: LCM_CONTEXT_ENGINE_ID,
    async ingest(params) {
      await runtime.ensureReady();
      const conversationId = resolveConversationId(params.sessionId, params.meta);
      const messageChannel =
        typeof params.meta?.messageChannel === "string" ? params.meta.messageChannel : undefined;
      const result = runtime.store
        ? await ingestCanonicalTranscript({
            store: runtime.store,
            tokenEstimator,
            conversationId,
            sessionId: params.sessionId,
            channel: messageChannel,
            provider: params.provider,
            modelId: params.modelId,
            messages: params.messages,
          })
        : null;
      return {
        messages: params.messages,
        meta: {
          ...params.meta,
          lcm: {
            runtimeReady: Boolean(runtime.store),
            phase: "ingest",
            conversationId,
            persistedMessages: result?.messageCount ?? 0,
          },
        },
      };
    },
    async assemble(params) {
      await runtime.ensureReady();
      const conversationId = resolveConversationIdFromMeta(params.meta);
      if (!runtime.assembler || !conversationId) {
        return {
          messages: params.messages,
          meta: {
            ...params.meta,
            lcm: {
              ...asRecord(params.meta?.lcm),
              runtimeReady: false,
              phase: "assemble",
              conversationId,
              assembledMessages: params.messages.length,
              assembledSummaries: 0,
              tokenEstimate: estimateAgentMessages(params.messages),
            },
          },
        };
      }

      const assembled = await runtime.assembler.assemble({
        conversationId,
        targetTokens: lcmConfig.targetTokens,
        freshTailCount: lcmConfig.freshTailCount,
      });
      const messages = toAgentMessages(assembled.messages, assembled.summaries);

      return {
        messages,
        meta: {
          ...params.meta,
          lcm: {
            ...asRecord(params.meta?.lcm),
            runtimeReady: Boolean(runtime.assembler),
            phase: "assemble",
            conversationId,
            assembledMessages: assembled.messages.length,
            assembledSummaries: assembled.summaries.length,
            tokenEstimate: assembled.tokenEstimate,
          },
        },
      };
    },
    async compact(params: ContextCompactParams) {
      await runtime.ensureReady();
      const conversationId = resolveConversationIdFromMeta(params.meta);
      if (!conversationId || !runtime.compaction) {
        return {
          ok: false,
          compacted: false,
          reason: "LCM compaction requires conversation metadata and compaction runtime.",
        };
      }

      const manual = Boolean(params.customInstructions?.trim()) || readBoolean(params.meta?.manual);
      const lcmMeta = asRecord(params.meta?.lcm);
      const estimateFromMeta = readNumber(lcmMeta.tokenEstimate);
      const assembledTokens = Math.max(
        0,
        Math.trunc(estimateFromMeta ?? estimateAgentMessages(params.messages)),
      );
      const result = await runtime.compaction.compact({
        conversationId,
        assembledTokens,
        modelTokenBudget: lcmConfig.compactionTokenThreshold,
        contextThreshold: 1,
        maxActiveMessages: 200,
        targetTokens: lcmConfig.targetTokens,
        freshTailCount: lcmConfig.freshTailCount,
        manual,
        customInstructions: params.customInstructions,
      });

      if (!result.compacted) {
        return {
          ok: true,
          compacted: false,
          reason: result.reason ?? "LCM compaction not required.",
        };
      }

      const activeItems = await runtime.store?.getContextItems({
        conversationId,
        includeTombstoned: false,
        itemTypes: ["message", "summary"],
        limit: 1,
      });
      const firstKeptEntryId =
        activeItems?.[0]?.itemId ??
        result.summaries.at(-1)?.messageEndId ??
        result.summaries[0]?.id;
      const summaryText = result.summaries.map((summary) => summary.text).join("\n\n");

      return {
        ok: true,
        compacted: true,
        result: {
          summary: summaryText || "Compaction completed.",
          firstKeptEntryId: firstKeptEntryId ?? "unknown",
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          details: {
            decision: result.decision,
            batches: result.batches,
            summaries: result.summaries.map((summary) => ({
              id: summary.id,
              kind: summary.kind,
            })),
            activeMessageCountBefore: result.activeMessageCountBefore,
            activeMessageCountAfter: result.activeMessageCountAfter,
          },
        },
      };
    },
  };
}

function resolveConversationIdFromMeta(meta?: Record<string, unknown>): ConversationId | null {
  const lcmMeta = asRecord(meta?.lcm);
  const fromLcm = lcmMeta.conversationId;
  if (typeof fromLcm === "string" && fromLcm.trim()) {
    return fromLcm.trim() as ConversationId;
  }

  const direct = meta?.conversationId;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim() as ConversationId;
  }
  return null;
}

function toConversationId(value?: string): ConversationId | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed as ConversationId;
}

function toPositiveInt(value: unknown, fallback: number, min = 1, max = 10_000): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function toAgentMessages(messages: LcmMessage[], summaries: LcmSummary[]): AgentMessage[] {
  const rawMessages = messages.map(
    (message) =>
      ({
        role: mapLcmRoleToAgentRole(message.role),
        content: message.content,
      }) as AgentMessage,
  );

  if (summaries.length === 0) {
    return rawMessages;
  }

  const summariesText = summaries
    .map((summary, index) => `${index + 1}. (${summary.kind}) ${summary.text}`)
    .join("\n");
  const summaryMessage = {
    role: "custom",
    content: `Prior conversation summaries:\n${summariesText}`,
  } as AgentMessage;

  const firstNonSystem = rawMessages.findIndex((message) => message.role !== "custom");
  if (firstNonSystem < 0) {
    return [...rawMessages, summaryMessage];
  }
  return [
    ...rawMessages.slice(0, firstNonSystem),
    summaryMessage,
    ...rawMessages.slice(firstNonSystem),
  ];
}

function mapLcmRoleToAgentRole(role: LcmMessage["role"]): AgentMessage["role"] {
  switch (role) {
    case "system":
      return "custom";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "toolResult";
  }
}

function estimateAgentMessages(messages: AgentMessage[]): number {
  const tokenEstimator = createPlaceholderTokenEstimator();
  let total = 0;
  for (const message of messages) {
    total += tokenEstimator.estimateText(readMessageText(message));
  }
  return total;
}

function readMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const lines: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const text = (part as { text?: unknown; content?: unknown; value?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      lines.push(text);
      continue;
    }
    const contentText = (part as { content?: unknown }).content;
    if (typeof contentText === "string" && contentText.trim()) {
      lines.push(contentText);
      continue;
    }
    const valueText = (part as { value?: unknown }).value;
    if (typeof valueText === "string" && valueText.trim()) {
      lines.push(valueText);
    }
  }
  return lines.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function retrievalUnavailableResult(action: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `LCM ${action} is unavailable because no retrieval engine is configured.`,
      },
    ],
    details: {
      action,
      available: false,
    },
  };
}

function jsonToolResult(action: string, payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: {
      action,
      available: true,
      payload,
    },
  };
}

function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) {
    return primary.trim();
  }
  return undefined;
}

function resolveRequesterSessionKey(rawSessionKey: string | undefined, cfg: OpenClawConfig) {
  const trimmed = rawSessionKey?.trim();
  if (!trimmed) {
    return undefined;
  }
  const { alias, mainKey } = resolveMainSessionAlias(cfg);
  return resolveInternalSessionKey({ key: trimmed, alias, mainKey });
}

async function runLcmExpansionSubagentPass(params: {
  requesterSessionKey: string;
  requesterChannel?: string;
  model?: string;
  passIndex: number;
  prompt: string;
  question: string;
  runTimeoutSeconds: number;
}) {
  const childSessionKey = `agent:${resolveAgentIdFromSessionKey(params.requesterSessionKey)}:subagent:${crypto.randomUUID()}`;
  const idem = crypto.randomUUID();
  let runId: string = idem;

  try {
    if (params.model) {
      await callGateway({
        method: "sessions.patch",
        params: { key: childSessionKey, model: params.model },
        timeoutMs: 10_000,
      });
    }

    const childSystemPrompt = buildSubagentSystemPrompt({
      requesterSessionKey: params.requesterSessionKey,
      childSessionKey,
      label: `LCM Deep Expand Pass ${params.passIndex}`,
      task: params.question,
    });

    const response = await callGateway<{ runId?: string }>({
      method: "agent",
      params: {
        message: params.prompt,
        sessionKey: childSessionKey,
        channel: params.requesterChannel,
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        spawnedBy: params.requesterSessionKey,
        idempotencyKey: idem,
        extraSystemPrompt: childSystemPrompt,
        timeout: params.runTimeoutSeconds > 0 ? params.runTimeoutSeconds : undefined,
        label: `LCM Deep Expand Pass ${params.passIndex}`,
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId) {
      runId = response.runId;
    }

    const waitTimeoutMs = Math.max(1_000, params.runTimeoutSeconds * 1_000);
    const wait = await callGateway<{ status?: string; error?: string }>({
      method: "agent.wait",
      params: {
        runId,
        timeoutMs: waitTimeoutMs,
      },
      timeoutMs: waitTimeoutMs + 2_000,
    });
    if (wait?.status === "timeout") {
      throw new Error(`LCM subagent pass ${params.passIndex} timed out.`);
    }
    if (wait?.status === "error") {
      throw new Error(wait.error || `LCM subagent pass ${params.passIndex} failed.`);
    }

    const reply = await readLatestAssistantReply({
      sessionKey: childSessionKey,
      limit: 120,
    });
    if (!reply?.trim()) {
      throw new Error(`LCM subagent pass ${params.passIndex} produced no assistant output.`);
    }
    return reply;
  } finally {
    try {
      await callGateway({
        method: "sessions.delete",
        params: { key: childSessionKey, deleteTranscript: true },
        timeoutMs: 10_000,
      });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * LCM plugin entry point.
 *
 * Registers:
 * - Context engine id: "lcm"
 * - Retrieval tools: lcm_describe, lcm_grep, lcm_expand
 */
const lcmPlugin: OpenClawPluginDefinition = {
  id: "lcm",
  name: "Lossless Context Management (Scaffold)",
  description: "Scaffold for pluggable LCM context assembly, compaction, and retrieval.",
  configSchema: LCM_PLUGIN_CONFIG_SCHEMA,
  register(api) {
    const lcmConfig = resolveLcmConfig({
      config: api.config,
      pluginConfig: api.pluginConfig,
    });
    const runtime = createScaffoldRuntime((message) => {
      api.logger.debug?.(message);
    });

    if (!registeredContextEngineIds().includes(LCM_CONTEXT_ENGINE_ID)) {
      registerContextEngine(LCM_CONTEXT_ENGINE_ID, () =>
        createLcmContextEngine(runtime, lcmConfig),
      );
      api.logger.info(
        `lcm: registered context engine "${LCM_CONTEXT_ENGINE_ID}" (targetTokens=${lcmConfig.targetTokens})`,
      );
    }

    api.registerTool(
      {
        name: "lcm_describe",
        label: "LCM Describe",
        description: "Describe a summary id or file id from LCM storage.",
        parameters: Type.Object({
          id: Type.String({
            description: "Summary id or file id to describe.",
            minLength: 1,
          }),
        }),
        async execute(_toolCallId, params) {
          if (!runtime.retrieval) {
            return retrievalUnavailableResult("describe");
          }
          await runtime.ensureReady();

          const input = params as { id?: string };
          const id = input.id?.trim();
          if (!id) {
            throw new Error("id is required.");
          }

          const result = await runtime.retrieval.describe(id);
          return jsonToolResult("describe", {
            id,
            found: Boolean(result),
            result,
          });
        },
      },
      { name: "lcm_describe", optional: true },
    );

    api.registerTool(
      {
        name: "lcm_grep",
        label: "LCM Grep",
        description: "Search LCM messages and summaries with regex or full-text mode.",
        parameters: Type.Object({
          query: Type.String({ description: "Search text." }),
          mode: Type.Optional(
            Type.String({
              enum: ["regex", "full_text"],
              description: "Search mode.",
            }),
          ),
          scope: Type.Optional(
            Type.String({
              enum: ["messages", "summaries", "both"],
              description: "Search scope.",
            }),
          ),
          conversationId: Type.Optional(Type.String({ description: "Conversation id scope." })),
          limit: Type.Optional(Type.Number({ description: "Maximum hits to return." })),
        }),
        async execute(_toolCallId, params) {
          if (!runtime.retrieval) {
            return retrievalUnavailableResult("grep");
          }
          await runtime.ensureReady();

          const input = params as {
            query: string;
            mode?: "regex" | "full_text";
            scope?: "messages" | "summaries" | "both";
            conversationId?: string;
            limit?: number;
          };
          const grepInput: RetrievalGrepInput = {
            query: input.query,
            mode: input.mode,
            scope: input.scope,
            conversationId: toConversationId(input.conversationId) ?? undefined,
            limit: toPositiveInt(input.limit, lcmConfig.retrievalK, 1, 200),
          };
          const result = await runtime.retrieval.grep(grepInput);
          return jsonToolResult("grep", result);
        },
      },
      { name: "lcm_grep", optional: true },
    );

    api.registerTool(
      {
        name: "lcm_expand",
        label: "LCM Expand",
        description: "Expand a summary id through lineage with bounded depth/token caps.",
        parameters: Type.Object({
          summaryId: Type.String({
            description: "Summary identifier to expand.",
            minLength: 1,
          }),
          depth: Type.Optional(Type.Number({ description: "Traversal depth (bounded)." })),
          includeMessages: Type.Optional(
            Type.Boolean({ description: "Include raw canonical messages in expansion results." }),
          ),
          tokenCap: Type.Optional(
            Type.Number({ description: "Maximum estimated tokens to return." }),
          ),
          limit: Type.Optional(Type.Number({ description: "Maximum expanded items to return." })),
        }),
        async execute(_toolCallId, params) {
          if (!runtime.retrieval) {
            return retrievalUnavailableResult("expand");
          }
          await runtime.ensureReady();

          const input = params as {
            summaryId: string;
            depth?: number;
            includeMessages?: boolean;
            tokenCap?: number;
            limit?: number;
          };
          const summaryId = input.summaryId?.trim();
          if (!summaryId) {
            throw new Error("summaryId is required.");
          }

          const expandInput: RetrievalExpandInput = {
            summaryId: summaryId as RetrievalExpandInput["summaryId"],
            depth: toPositiveInt(input.depth, 2, 0, 8),
            includeMessages: input.includeMessages ?? true,
            tokenCap: toPositiveInt(input.tokenCap, 4_000, 1, 20_000),
            limit: toPositiveInt(input.limit, lcmConfig.retrievalK, 1, 500),
          };
          const result = await runtime.retrieval.expand(expandInput);
          return jsonToolResult("expand", result);
        },
      },
      { name: "lcm_expand", optional: true },
    );

    api.registerTool(
      (toolContext) => ({
        name: "lcm_expand_deep",
        label: "LCM Expand Deep",
        description:
          "Run iterative deep expansion over summary ids with direct-or-subagent orchestration.",
        parameters: Type.Object({
          targetIds: Type.Array(
            Type.String({
              description: "Summary identifiers to expand from.",
              minLength: 1,
            }),
            { minItems: 1, description: "Root summary ids for deep traversal." },
          ),
          question: Type.String({ description: "Focused question for deep traversal." }),
          depth: Type.Optional(
            Type.Number({ description: "Maximum traversal depth (policy-bounded)." }),
          ),
          tokenBudget: Type.Optional(
            Type.Number({ description: "Total token budget across all expansion passes." }),
          ),
          maxPasses: Type.Optional(
            Type.Number({ description: "Maximum iterative subagent expansion passes." }),
          ),
          includeMessages: Type.Optional(
            Type.Boolean({
              description: "Include raw canonical messages during direct (non-subagent) expansion.",
            }),
          ),
          strategy: Type.Optional(
            Type.String({
              enum: ["auto", "direct", "subagent"],
              description: "Strategy override; auto applies policy.",
            }),
          ),
          model: Type.Optional(
            Type.String({
              description: "Subagent model override (provider/model or model id).",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          if (!runtime.retrieval) {
            return retrievalUnavailableResult("expand_deep");
          }
          await runtime.ensureReady();

          const input = params as {
            targetIds?: string[];
            question?: string;
            depth?: number;
            tokenBudget?: number;
            maxPasses?: number;
            includeMessages?: boolean;
            strategy?: "auto" | "direct" | "subagent";
            model?: string;
          };
          const targetIds = (input.targetIds ?? []).map((value) => value.trim()).filter(Boolean);
          if (targetIds.length === 0) {
            throw new Error("targetIds must include at least one summary id.");
          }
          const question = input.question?.trim();
          if (!question) {
            throw new Error("question is required.");
          }

          const depth = toPositiveInt(input.depth, 3, 0, 8);
          const tokenBudget = toPositiveInt(input.tokenBudget, 8_000, 1, 20_000);
          const maxPasses = toPositiveInt(
            input.maxPasses,
            Math.max(1, Math.ceil(depth / 3)),
            1,
            12,
          );
          const requesterSessionKey = resolveRequesterSessionKey(
            toolContext.sessionKey,
            api.config,
          );
          const resolvedModel =
            normalizeModelSelection(input.model) ??
            normalizeModelSelection(api.config.agents?.defaults?.subagents?.model);

          const runTimeoutSeconds = 90;
          const runSubagent: SubagentExpansionRunner | undefined = requesterSessionKey
            ? async (request) =>
                await runLcmExpansionSubagentPass({
                  requesterSessionKey,
                  requesterChannel: toolContext.messageChannel,
                  model: resolvedModel,
                  passIndex: request.passIndex,
                  prompt: request.prompt,
                  question,
                  runTimeoutSeconds,
                })
            : undefined;

          const orchestrator = new SubagentExpansionOrchestrator({
            retrieval: runtime.retrieval,
            runSubagent,
          });

          const result = await orchestrator.expandDeep({
            targetIds,
            question,
            depth,
            tokenCap: tokenBudget,
            maxPasses,
            includeMessages: input.includeMessages ?? false,
            strategy: input.strategy ?? "auto",
          });

          return jsonToolResult("expand_deep", {
            strategy: result.strategy,
            synthesis: result.synthesis,
            citedIds: result.citedIds,
            nextSummaryIds: result.nextSummaryIds,
            truncated: result.truncated,
            passCount: result.passCount,
            depthUsed: result.depthUsed,
            tokenBudgetUsed: result.tokenBudgetUsed,
            warnings: result.warnings,
            passes: result.passes,
            model: resolvedModel,
          });
        },
      }),
      { name: "lcm_expand_deep", optional: true },
    );
  },
};

export default lcmPlugin;
