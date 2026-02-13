import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

/**
 * Extract the stable compaction payload shape from auto_compaction_end events.
 * We only capture results that contain the full summary + token metadata.
 */
function extractCompactionResult(evt: AgentEvent & { result?: unknown }) {
  const result = evt.result;
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const summary =
    typeof (result as { summary?: unknown }).summary === "string"
      ? (result as { summary: string }).summary
      : undefined;
  const tokensBefore =
    typeof (result as { tokensBefore?: unknown }).tokensBefore === "number" &&
    Number.isFinite((result as { tokensBefore: number }).tokensBefore)
      ? (result as { tokensBefore: number }).tokensBefore
      : undefined;
  if (!summary || tokensBefore === undefined) {
    return undefined;
  }
  const firstKeptEntryId =
    typeof (result as { firstKeptEntryId?: unknown }).firstKeptEntryId === "string"
      ? (result as { firstKeptEntryId: string }).firstKeptEntryId
      : undefined;
  return {
    summary,
    tokensBefore,
    firstKeptEntryId,
  };
}

export function handleAutoCompactionStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.state.compactionInFlight = true;
  ctx.incrementCompactionCount();
  ctx.ensureCompactionPromise();
  ctx.log.debug(`embedded run compaction start: runId=${ctx.params.runId}`);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "start" },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "start" },
  });

  // Run before_compaction plugin hook (fire-and-forget)
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_compaction")) {
    void hookRunner
      .runBeforeCompaction(
        {
          messageCount: ctx.params.session.messages?.length ?? 0,
        },
        {},
      )
      .catch((err) => {
        ctx.log.warn(`before_compaction hook failed: ${String(err)}`);
      });
  }
}

export function handleAutoCompactionEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { willRetry?: unknown; result?: unknown },
) {
  const compactionResult = extractCompactionResult(evt);
  if (compactionResult) {
    ctx.setLastCompactionResult(compactionResult);
  }
  ctx.state.compactionInFlight = false;
  const willRetry = Boolean(evt.willRetry);
  if (willRetry) {
    ctx.noteCompactionRetry();
    ctx.resetForCompactionRetry();
    ctx.log.debug(`embedded run compaction retry: runId=${ctx.params.runId}`);
  } else {
    ctx.maybeResolveCompactionWait();
  }
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "end", willRetry },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "end", willRetry },
  });

  // Run after_compaction plugin hook (fire-and-forget)
  if (!willRetry) {
    const hookRunnerEnd = getGlobalHookRunner();
    if (hookRunnerEnd?.hasHooks("after_compaction")) {
      void hookRunnerEnd
        .runAfterCompaction(
          {
            messageCount: ctx.params.session.messages?.length ?? 0,
            compactedCount: ctx.getCompactionCount(),
          },
          {},
        )
        .catch((err) => {
          ctx.log.warn(`after_compaction hook failed: ${String(err)}`);
        });
    }
  }
}
