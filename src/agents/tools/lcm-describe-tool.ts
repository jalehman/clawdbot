import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { LcmContextEngine } from "../../plugins/lcm/engine.js";
import type { AnyAgentTool } from "./common.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import { jsonResult } from "./common.js";

const LcmDescribeSchema = Type.Object({
  id: Type.String({
    description: "The LCM ID to look up. Use sum_xxx for summaries, file_xxx for files.",
  }),
});

export function createLcmDescribeTool(options?: { config?: OpenClawConfig }): AnyAgentTool {
  return {
    name: "lcm_describe",
    label: "LCM Describe",
    description:
      "Look up metadata and content for an LCM item by ID. " +
      "Use this to inspect summaries (sum_xxx) or stored files (file_xxx) " +
      "from compacted conversation history. Returns summary content, lineage, " +
      "token counts, and file exploration results.",
    parameters: LcmDescribeSchema,
    async execute(_toolCallId, params) {
      ensureContextEnginesInitialized();
      const engine = await resolveContextEngine(options?.config);

      if (engine.info.id !== "lcm") {
        return jsonResult({
          error: "lcm_describe requires the LCM context engine to be active.",
        });
      }

      const lcm = engine as LcmContextEngine;
      const retrieval = lcm.getRetrieval();
      const id = (params as { id: string }).id.trim();

      const result = await retrieval.describe(id);

      if (!result) {
        return jsonResult({
          error: `Not found: ${id}`,
          hint: "Check the ID format (sum_xxx for summaries, file_xxx for files).",
        });
      }

      if (result.type === "summary" && result.summary) {
        const s = result.summary;
        const lines: string[] = [];
        lines.push(`## LCM Summary: ${id}`);
        lines.push("");
        lines.push(`**Kind:** ${s.kind}`);
        lines.push(`**Tokens:** ~${s.tokenCount.toLocaleString()}`);
        lines.push(`**Created:** ${s.createdAt.toISOString()}`);
        if (s.parentIds.length > 0) {
          lines.push(`**Parents:** ${s.parentIds.join(", ")}`);
        }
        if (s.childIds.length > 0) {
          lines.push(`**Children:** ${s.childIds.join(", ")}`);
        }
        if (s.messageIds.length > 0) {
          lines.push(`**Messages:** ${s.messageIds.length} linked`);
        }
        if (s.fileIds.length > 0) {
          lines.push(`**Files:** ${s.fileIds.join(", ")}`);
        }
        lines.push("");
        lines.push("## Content");
        lines.push("");
        lines.push(s.content);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: result,
        };
      }

      if (result.type === "file" && result.file) {
        const f = result.file;
        const lines: string[] = [];
        lines.push(`## LCM File: ${id}`);
        lines.push("");
        lines.push(`**Name:** ${f.fileName ?? "(no name)"}`);
        lines.push(`**Type:** ${f.mimeType ?? "unknown"}`);
        if (f.byteSize != null) {
          lines.push(`**Size:** ${f.byteSize.toLocaleString()} bytes`);
        }
        lines.push(`**Created:** ${f.createdAt.toISOString()}`);
        if (f.explorationSummary) {
          lines.push("");
          lines.push("## Exploration Summary");
          lines.push("");
          lines.push(f.explorationSummary);
        } else {
          lines.push("");
          lines.push("*No exploration summary available.*");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: result,
        };
      }

      return jsonResult(result);
    },
  };
}
