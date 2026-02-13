import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { LcmContextEngine } from "../../plugins/lcm/engine.js";
import type { AnyAgentTool } from "./common.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import { ExpansionOrchestrator, distillForSubagent } from "../../plugins/lcm/expansion.js";
import { jsonResult } from "./common.js";

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
      const tokenCap = typeof p.tokenCap === "number" ? Math.trunc(p.tokenCap) : undefined;
      const includeMessages = typeof p.includeMessages === "boolean" ? p.includeMessages : false;
      const conversationId = typeof p.conversationId === "number" ? p.conversationId : undefined;

      if (query) {
        if (conversationId == null) {
          return jsonResult({
            error: "conversationId is required when using query-based expansion.",
          });
        }
        const result = await orchestrator.describeAndExpand({
          query,
          mode: "full_text",
          conversationId,
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
        const result = await orchestrator.expand({
          summaryIds,
          maxDepth,
          tokenCap,
          includeMessages,
          conversationId: conversationId ?? 0,
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
