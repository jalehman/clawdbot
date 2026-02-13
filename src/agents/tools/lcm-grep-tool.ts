import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { LcmContextEngine } from "../../plugins/lcm/engine.js";
import type { AnyAgentTool } from "./common.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import { jsonResult } from "./common.js";

const MAX_RESULT_CHARS = 40_000; // ~10k tokens

const LcmGrepSchema = Type.Object({
  pattern: Type.String({
    description:
      "Search pattern. Interpreted as regex when mode is 'regex', or as a text query for 'full_text' mode.",
  }),
  mode: Type.Optional(
    Type.String({
      description:
        'Search mode: "regex" for regular expression matching, "full_text" for text search. Default: "regex".',
      enum: ["regex", "full_text"],
    }),
  ),
  scope: Type.Optional(
    Type.String({
      description:
        'What to search: "messages" for raw messages, "summaries" for compacted summaries, "both" for all. Default: "both".',
      enum: ["messages", "summaries", "both"],
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID to search within. If omitted, searches all conversations.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of results to return (default: 50).",
      minimum: 1,
      maximum: 200,
    }),
  ),
});

function truncateSnippet(content: string, maxLen: number = 200): string {
  const singleLine = content.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLen) {
    return singleLine;
  }
  return singleLine.substring(0, maxLen - 3) + "...";
}

export function createLcmGrepTool(options?: { config?: OpenClawConfig }): AnyAgentTool {
  return {
    name: "lcm_grep",
    label: "LCM Grep",
    description:
      "Search compacted conversation history using regex or full-text search. " +
      "Searches across messages and/or summaries stored by LCM. " +
      "Use this to find specific content that may have been compacted away from " +
      "active context. Returns matching snippets with their summary/message IDs " +
      "for follow-up with lcm_expand or lcm_describe.",
    parameters: LcmGrepSchema,
    async execute(_toolCallId, params) {
      ensureContextEnginesInitialized();
      const engine = await resolveContextEngine(options?.config);

      if (engine.info.id !== "lcm") {
        return jsonResult({
          error: "lcm_grep requires the LCM context engine to be active.",
        });
      }

      const lcm = engine as LcmContextEngine;
      const retrieval = lcm.getRetrieval();

      const p = params as Record<string, unknown>;
      const pattern = (p.pattern as string).trim();
      const mode = (p.mode as "regex" | "full_text") ?? "regex";
      const scope = (p.scope as "messages" | "summaries" | "both") ?? "both";
      const conversationId = typeof p.conversationId === "number" ? p.conversationId : undefined;
      const limit = typeof p.limit === "number" ? Math.trunc(p.limit) : 50;

      const result = await retrieval.grep({
        query: pattern,
        mode,
        scope,
        conversationId,
        limit,
      });

      const lines: string[] = [];
      lines.push("## LCM Grep Results");
      lines.push(`**Pattern:** \`${pattern}\``);
      lines.push(`**Mode:** ${mode} | **Scope:** ${scope}`);
      if (conversationId != null) {
        lines.push(`**Conversation:** ${conversationId}`);
      }
      lines.push(`**Total matches:** ${result.totalMatches}`);
      lines.push("");

      let currentChars = lines.join("\n").length;

      if (result.messages.length > 0) {
        lines.push("### Messages");
        lines.push("");
        for (const msg of result.messages) {
          const snippet = truncateSnippet(msg.snippet);
          const line = `- [msg#${msg.messageId}] (${msg.role}): ${snippet}`;
          if (currentChars + line.length > MAX_RESULT_CHARS) {
            lines.push("*(truncated — more results available)*");
            break;
          }
          lines.push(line);
          currentChars += line.length;
        }
        lines.push("");
      }

      if (result.summaries.length > 0) {
        lines.push("### Summaries");
        lines.push("");
        for (const sum of result.summaries) {
          const snippet = truncateSnippet(sum.snippet);
          const line = `- [${sum.summaryId}] (${sum.kind}): ${snippet}`;
          if (currentChars + line.length > MAX_RESULT_CHARS) {
            lines.push("*(truncated — more results available)*");
            break;
          }
          lines.push(line);
          currentChars += line.length;
        }
        lines.push("");
      }

      if (result.totalMatches === 0) {
        lines.push("No matches found.");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          messageCount: result.messages.length,
          summaryCount: result.summaries.length,
          totalMatches: result.totalMatches,
        },
      };
    },
  };
}
