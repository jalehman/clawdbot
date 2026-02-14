import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";

export type LcmSummarizeFn = (text: string, aggressive?: boolean) => Promise<string>;

export type LcmSummarizerLegacyParams = {
  provider?: unknown;
  model?: unknown;
  config?: unknown;
  agentDir?: unknown;
  authProfileId?: unknown;
};

type SummaryMode = "normal" | "aggressive";

const SUMMARY_TIMEOUT_MS = 45_000;

/** Approximate token estimate used for target-sizing prompts. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Narrows pi-ai response blocks to plain text content blocks. */
function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

/**
 * Resolve a practical target token count for normal vs aggressive summaries.
 * Aggressive mode intentionally aims lower so compaction can converge faster.
 */
function resolveTargetTokens(inputTokens: number, mode: SummaryMode): number {
  if (mode === "aggressive") {
    return Math.max(96, Math.min(640, Math.floor(inputTokens * 0.2)));
  }
  return Math.max(192, Math.min(1200, Math.floor(inputTokens * 0.35)));
}

/**
 * Build a mode-specific summarization prompt.
 *
 * Normal mode prioritizes retaining details; aggressive mode keeps only the
 * highest-value facts required for future turns.
 */
function buildSummaryPrompt(params: {
  text: string;
  mode: SummaryMode;
  targetTokens: number;
  customInstructions?: string;
}): string {
  const { text, mode, targetTokens, customInstructions } = params;

  const policy =
    mode === "aggressive"
      ? [
          "Aggressive summary policy:",
          "- Keep only durable facts and current task state.",
          "- Remove examples, repetition, and low-value narrative details.",
          "- Preserve explicit TODOs, blockers, decisions, and constraints.",
        ].join("\n")
      : [
          "Normal summary policy:",
          "- Preserve key decisions, rationale, constraints, and active tasks.",
          "- Keep essential technical details needed to continue work safely.",
          "- Remove obvious repetition and conversational filler.",
        ].join("\n");

  const instructionBlock = customInstructions?.trim()
    ? `Operator instructions:\n${customInstructions.trim()}`
    : "Operator instructions: (none)";

  return [
    "You summarize OpenClaw LCM context for future model turns.",
    policy,
    instructionBlock,
    [
      "Output requirements:",
      "- Plain text only.",
      "- No preamble, headings, or markdown formatting.",
      "- Keep it concise while preserving required details.",
      `- Target length: about ${targetTokens} tokens or less.`,
    ].join("\n"),
    `<conversation_to_summarize>\n${text}\n</conversation_to_summarize>`,
  ].join("\n\n");
}

/**
 * Builds a model-backed LCM summarize callback from runtime legacy params.
 *
 * Returns `undefined` when model/provider context is unavailable so callers can
 * choose a fallback summarizer.
 */
export async function createLcmSummarizeFromLegacyParams(params: {
  legacyParams: LcmSummarizerLegacyParams;
  customInstructions?: string;
}): Promise<LcmSummarizeFn | undefined> {
  const provider =
    typeof params.legacyParams.provider === "string" ? params.legacyParams.provider.trim() : "";
  const model =
    typeof params.legacyParams.model === "string" ? params.legacyParams.model.trim() : "";

  if (!provider || !model) {
    return undefined;
  }

  const agentDir =
    typeof params.legacyParams.agentDir === "string"
      ? params.legacyParams.agentDir
      : resolveOpenClawAgentDir();
  const cfg = params.legacyParams.config as OpenClawConfig | undefined;

  const resolved = resolveModel(provider, model, agentDir, cfg);
  if (!resolved.model) {
    return undefined;
  }

  const resolvedModel = resolved.model;

  const authProfileId =
    typeof params.legacyParams.authProfileId === "string"
      ? params.legacyParams.authProfileId
      : undefined;

  const auth = await getApiKeyForModel({
    model: resolvedModel,
    cfg,
    profileId: authProfileId,
    agentDir,
  });

  let apiKey: string | undefined;
  if (resolvedModel.provider === "github-copilot") {
    const { resolveCopilotApiToken } = await import("../../providers/github-copilot-token.js");
    const githubToken = requireApiKey(auth, resolvedModel.provider);
    const copilotToken = await resolveCopilotApiToken({ githubToken });
    apiKey = copilotToken.token;
  } else if (auth.mode !== "aws-sdk") {
    apiKey = requireApiKey(auth, resolvedModel.provider);
  }

  return async (text: string, aggressive?: boolean): Promise<string> => {
    if (!text.trim()) {
      return "";
    }

    const mode: SummaryMode = aggressive ? "aggressive" : "normal";
    const targetTokens = resolveTargetTokens(estimateTokens(text), mode);
    const prompt = buildSummaryPrompt({
      text,
      mode,
      targetTokens,
      customInstructions: params.customInstructions,
    });

    const controller = new AbortController();
    const timeout = setTimeout(controller.abort.bind(controller), SUMMARY_TIMEOUT_MS);

    try {
      const result = await completeSimple(
        resolvedModel,
        {
          messages: [
            {
              role: "user",
              content: prompt,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: targetTokens,
          temperature: aggressive ? 0.1 : 0.2,
          signal: controller.signal,
        },
      );

      const summary = result.content
        .filter(isTextContentBlock)
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join("\n")
        .trim();

      if (!summary) {
        throw new Error("LCM summarizer returned empty output");
      }

      return summary;
    } finally {
      clearTimeout(timeout);
    }
  };
}
