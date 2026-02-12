import { Type } from "@sinclair/typebox";
import path from "node:path";
import type { OpenClawPluginDefinition } from "../plugins/types.js";
import type { ConversationId, LcmRuntime } from "./types.js";
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

function buildNotImplementedMessage(
  action: string,
  conversationId?: ConversationId | null,
): string {
  const suffix = conversationId ? ` for conversation "${conversationId}"` : "";
  return `LCM ${action}${suffix} is scaffolded but not implemented yet.`;
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
        description: "Inspect the current LCM conversation summary layout.",
        parameters: Type.Object({
          conversationId: Type.Optional(
            Type.String({ description: "Conversation id to inspect." }),
          ),
          limit: Type.Optional(Type.Number({ description: "Maximum summary records to inspect." })),
        }),
        async execute(_toolCallId, params) {
          const input = params as { conversationId?: string; limit?: number };
          const conversationId = toConversationId(input.conversationId);
          const limit = typeof input.limit === "number" ? Math.max(1, Math.trunc(input.limit)) : 20;
          return {
            content: [
              {
                type: "text",
                text: buildNotImplementedMessage("describe", conversationId),
              },
            ],
            details: {
              action: "describe",
              conversationId,
              limit,
              config: lcmConfig,
              estimator: "PlaceholderTokenEstimator",
            },
          };
        },
      },
      { name: "lcm_describe", optional: true },
    );

    api.registerTool(
      {
        name: "lcm_grep",
        label: "LCM Grep",
        description: "Search LCM-managed history without loading the full transcript.",
        parameters: Type.Object({
          query: Type.String({ description: "Search text." }),
          conversationId: Type.Optional(Type.String({ description: "Conversation id scope." })),
          limit: Type.Optional(Type.Number({ description: "Maximum hits to return." })),
        }),
        async execute(_toolCallId, params) {
          const input = params as { query: string; conversationId?: string; limit?: number };
          const conversationId = toConversationId(input.conversationId);
          const limit = typeof input.limit === "number" ? Math.max(1, Math.trunc(input.limit)) : 10;
          return {
            content: [
              {
                type: "text",
                text: buildNotImplementedMessage("grep", conversationId),
              },
            ],
            details: {
              action: "grep",
              query: input.query,
              conversationId,
              limit,
            },
          };
        },
      },
      { name: "lcm_grep", optional: true },
    );

    api.registerTool(
      {
        name: "lcm_expand",
        label: "LCM Expand",
        description: "Expand an LCM summary anchor back into original message spans.",
        parameters: Type.Object({
          summaryId: Type.Optional(Type.String({ description: "Summary identifier to expand." })),
          conversationId: Type.Optional(Type.String({ description: "Conversation id scope." })),
          limit: Type.Optional(Type.Number({ description: "Maximum messages to expand." })),
        }),
        async execute(_toolCallId, params) {
          const input = params as { summaryId?: string; conversationId?: string; limit?: number };
          const conversationId = toConversationId(input.conversationId);
          const limit = typeof input.limit === "number" ? Math.max(1, Math.trunc(input.limit)) : 20;
          return {
            content: [
              {
                type: "text",
                text: buildNotImplementedMessage("expand", conversationId),
              },
            ],
            details: {
              action: "expand",
              summaryId: input.summaryId?.trim() || null,
              conversationId,
              limit,
            },
          };
        },
      },
      { name: "lcm_expand", optional: true },
    );
  },
};

export default lcmPlugin;
