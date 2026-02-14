import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { LcmContextEngine } from "../../plugins/lcm/engine.js";
import type { AnyAgentTool } from "./common.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import { resolveLcmConfig } from "../../plugins/lcm/db/config.js";
import {
  ExpansionOrchestrator,
  distillForSubagent,
  resolveExpansionTokenCap,
} from "../../plugins/lcm/expansion.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

const LcmExpandSchema = Type.Object({
  summaryIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "Summary IDs to expand (sum_xxx format). Required if query is not provided.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Text query to grep for matching summaries before expanding. " +
        "If provided, summaryIds is ignored and the top grep results are expanded.",
    }),
  ),
  maxDepth: Type.Optional(
    Type.Number({
      description: "Max traversal depth per summary (default: 3).",
      minimum: 1,
      maximum: 10,
    }),
  ),
  tokenCap: Type.Optional(
    Type.Number({
      description: "Max tokens across the entire expansion result.",
      minimum: 1,
    }),
  ),
  includeMessages: Type.Optional(
    Type.Boolean({
      description: "Whether to include raw source messages at leaf level (default: false).",
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description:
        "Conversation ID to scope the expansion to. If omitted, uses the current session's conversation.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description:
        "Set true to explicitly allow cross-conversation expansion. Ignored when conversationId is provided.",
    }),
  ),
});

export function createLcmExpandTool(options?: {
  config?: OpenClawConfig;
  sessionId?: string;
}): AnyAgentTool {
  return {
    name: "lcm_expand",
    label: "LCM Expand",
    description:
      "Expand compacted conversation summaries from LCM (Lossless Context Management). " +
      "Traverses the summary DAG to retrieve children and source messages. " +
      "Use this to drill into previously-compacted context when you need detail " +
      "that was summarised away. Provide either summaryIds (direct expansion) or " +
      "query (grep-first, then expand top matches). Returns a compact text payload " +
      "with cited IDs for follow-up.",
    parameters: LcmExpandSchema,
    async execute(_toolCallId, params) {
      ensureContextEnginesInitialized();
      const engine = await resolveContextEngine(options?.config);

      if (engine.info.id !== "lcm") {
        return jsonResult({
          error: "lcm_expand requires the LCM context engine to be active.",
        });
      }

      const lcm = engine as LcmContextEngine;
      const retrieval = lcm.getRetrieval();
      const orchestrator = new ExpansionOrchestrator(retrieval);

      const p = params as Record<string, unknown>;
      const summaryIds = p.summaryIds as string[] | undefined;
      const query = typeof p.query === "string" ? p.query.trim() : undefined;
      const maxDepth = typeof p.maxDepth === "number" ? Math.trunc(p.maxDepth) : undefined;
      const requestedTokenCap = typeof p.tokenCap === "number" ? Math.trunc(p.tokenCap) : undefined;
      const tokenCap = resolveExpansionTokenCap({
        requestedTokenCap,
        maxExpandTokens: resolveLcmConfig().maxExpandTokens,
      });
      const includeMessages = typeof p.includeMessages === "boolean" ? p.includeMessages : false;
      const conversationScope = await resolveLcmConversationScope({
        lcm,
        sessionId: options?.sessionId,
        params: p,
      });
      if (!conversationScope.allConversations && conversationScope.conversationId == null) {
        return jsonResult({
          error:
            "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
        });
      }

      if (query) {
        const result = await orchestrator.describeAndExpand({
          query,
          mode: "full_text",
          conversationId: conversationScope.conversationId,
          maxDepth,
          tokenCap,
        });
        const text = distillForSubagent(result);
        return {
          content: [{ type: "text", text }],
          details: {
            expansionCount: result.expansions.length,
            citedIds: result.citedIds,
            totalTokens: result.totalTokens,
            truncated: result.truncated,
          },
        };
      }

      if (summaryIds && summaryIds.length > 0) {
        if (conversationScope.conversationId != null) {
          const outOfScope: string[] = [];
          for (const summaryId of summaryIds) {
            const described = await retrieval.describe(summaryId);
            if (
              described?.type === "summary" &&
              described.summary?.conversationId !== conversationScope.conversationId
            ) {
              outOfScope.push(summaryId);
            }
          }
          if (outOfScope.length > 0) {
            return jsonResult({
              error:
                `Some summaryIds are outside conversation ${conversationScope.conversationId}: ` +
                `${outOfScope.join(", ")}`,
              hint: "Use allConversations=true for cross-conversation expansion.",
            });
          }
        }

        const result = await orchestrator.expand({
          summaryIds,
          maxDepth,
          tokenCap,
          includeMessages,
          conversationId: conversationScope.conversationId ?? 0,
        });
        const text = distillForSubagent(result);
        return {
          content: [{ type: "text", text }],
          details: {
            expansionCount: result.expansions.length,
            citedIds: result.citedIds,
            totalTokens: result.totalTokens,
            truncated: result.truncated,
          },
        };
      }

      return jsonResult({
        error: "Either summaryIds or query must be provided.",
      });
    },
  };
}
