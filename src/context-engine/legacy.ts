import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { registerContextEngine } from "./registry.js";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
} from "./types.js";

/**
 * LegacyContextEngine wraps the existing compaction behavior behind the
 * ContextEngine interface, preserving 100% backward compatibility.
 *
 * - ingest: no-op (SessionManager handles message persistence)
 * - assemble: pass-through (existing sanitize/validate/limit pipeline in attempt.ts handles this)
 * - compact: delegates to compactEmbeddedPiSessionDirect
 */
export class LegacyContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "legacy",
    name: "Legacy Context Engine",
    version: "1.0.0",
  };

  async ingest(_params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    // No-op: SessionManager handles message persistence in the legacy flow
    return { ingested: false };
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    // Pass-through: the existing sanitize -> validate -> limit -> repair pipeline
    // in attempt.ts handles context assembly for the legacy engine.
    // We just return the messages as-is with a rough token estimate.
    return {
      messages: params.messages,
      estimatedTokens: 0, // Caller handles estimation
    };
  }

  async afterTurn(_params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    legacyCompactionParams?: Record<string, unknown>;
  }): Promise<void> {
    // No-op: legacy flow persists context directly in SessionManager.
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    legacyParams?: Record<string, unknown>;
  }): Promise<CompactResult> {
    // Import dynamically to avoid circular dependencies
    const { compactEmbeddedPiSessionDirect } =
      await import("../agents/pi-embedded-runner/compact.js");

    // Extract legacy params - these map directly to CompactEmbeddedPiSessionParams
    const lp = params.legacyParams ?? {};

    const result = await compactEmbeddedPiSessionDirect({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      customInstructions: params.customInstructions,
      workspaceDir: (lp.workspaceDir as string) ?? process.cwd(),
      sessionKey: lp.sessionKey as string | undefined,
      messageChannel: lp.messageChannel as string | undefined,
      messageProvider: lp.messageProvider as string | undefined,
      agentAccountId: lp.agentAccountId as string | undefined,
      authProfileId: lp.authProfileId as string | undefined,
      groupId: lp.groupId as string | null | undefined,
      groupChannel: lp.groupChannel as string | null | undefined,
      groupSpace: lp.groupSpace as string | null | undefined,
      spawnedBy: lp.spawnedBy as string | null | undefined,
      senderIsOwner: lp.senderIsOwner as boolean | undefined,
      config: lp.config as any,
      skillsSnapshot: lp.skillsSnapshot as any,
      agentDir: lp.agentDir as string | undefined,
      provider: lp.provider as string | undefined,
      model: lp.model as string | undefined,
      thinkLevel: lp.thinkLevel as any,
      reasoningLevel: lp.reasoningLevel as any,
      bashElevated: lp.bashElevated as any,
      extraSystemPrompt: lp.extraSystemPrompt as string | undefined,
      ownerNumbers: lp.ownerNumbers as string[] | undefined,
      lane: lp.lane as string | undefined,
      enqueue: lp.enqueue as any,
    });

    return {
      ok: result.ok,
      compacted: result.compacted,
      reason: result.reason,
      result: result.result
        ? {
            summary: result.result.summary,
            firstKeptEntryId: result.result.firstKeptEntryId,
            tokensBefore: result.result.tokensBefore,
            tokensAfter: result.result.tokensAfter,
            details: result.result.details,
          }
        : undefined,
    };
  }

  async dispose(): Promise<void> {
    // Nothing to clean up for legacy engine
  }
}

export function registerLegacyContextEngine(): void {
  registerContextEngine("legacy", () => new LegacyContextEngine());
}
