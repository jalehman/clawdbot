import { Type } from "@sinclair/typebox";
import path from "node:path";
import type { OpenClawPluginDefinition } from "../plugins/types.js";
import type {
  ConversationId,
  LcmRuntime,
  RetrievalExpandInput,
  RetrievalGrepInput,
} from "./types.js";
import { resolveStateDir } from "../config/paths.js";
import {
  registerContextEngine,
  registeredContextEngineIds,
  type ContextCompactParams,
  type ContextEngine,
} from "../context-engine/index.js";
import { LCM_PLUGIN_CONFIG_SCHEMA, resolveLcmConfig } from "./config.js";
import { createConversationStore } from "./conversation-store.js";
import { ingestCanonicalTranscript, resolveConversationId } from "./ingestion.js";
import { createLcmStorageBackend } from "./storage/backend.js";
import { createPlaceholderTokenEstimator } from "./token-estimator.js";

/**
 * Canonical id for the scaffolded LCM engine.
 */
export const LCM_CONTEXT_ENGINE_ID = "lcm";

type LcmPluginRuntime = LcmRuntime & {
  ensureReady: () => Promise<void>;
};

function createScaffoldRuntime(): LcmPluginRuntime {
  const storage = createLcmStorageBackend({
    sqlite: {
      dbPath: path.join(resolveStateDir(), "lcm", "lcm.sqlite"),
    },
  });
  const store = createConversationStore({ storage });
  let readyPromise: Promise<void> | null = null;
  return {
    store,
    ensureReady() {
      if (!readyPromise) {
        readyPromise = storage.migrate();
      }
      return readyPromise;
    },
  };
}

/**
 * Build an LCM context engine scaffold with canonical ingest persistence.
 */
function createLcmContextEngine(runtime: LcmPluginRuntime): ContextEngine {
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
      return {
        messages: params.messages,
        meta: {
          ...params.meta,
          lcm: {
            runtimeReady: Boolean(runtime.assembler),
            phase: "assemble",
          },
        },
      };
    },
    async compact(_params: ContextCompactParams) {
      return {
        ok: false,
        compacted: false,
        reason: "LCM compaction engine is not implemented yet.",
      };
    },
  };
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
    const runtime = createScaffoldRuntime();

    if (!registeredContextEngineIds().includes(LCM_CONTEXT_ENGINE_ID)) {
      registerContextEngine(LCM_CONTEXT_ENGINE_ID, () => createLcmContextEngine(runtime));
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
  },
};

export default lcmPlugin;
