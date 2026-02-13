import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId } from "./types.js";
import { createCompactionEngine } from "./compaction-engine.js";
import { createConversationStore } from "./conversation-store.js";
import { ingestCanonicalTranscript } from "./ingestion.js";
import { createLcmMetrics } from "./observability.js";
import { createLcmRetrievalEngine } from "./retrieval-engine.js";
import { createSqliteLcmStorageBackend } from "./storage/sqlite.js";
import { createPlaceholderTokenEstimator } from "./token-estimator.js";

const OPEN_BACKENDS = new Set<ReturnType<typeof createSqliteLcmStorageBackend>>();
const OPEN_DIRS = new Set<string>();

afterEach(async () => {
  for (const backend of OPEN_BACKENDS) {
    await backend.close();
  }
  OPEN_BACKENDS.clear();

  for (const dir of OPEN_DIRS) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  OPEN_DIRS.clear();
});

describe("createLcmMetrics", () => {
  it("records counters, latencies, and structured event fields", () => {
    const events: Array<Record<string, unknown>> = [];
    const metrics = createLcmMetrics({
      onEvent(event) {
        events.push(event);
      },
      historyLimit: 20,
    });

    metrics.recordContextTokens({
      conversationId: "conv-observe",
      sessionId: "session-observe",
      tokens: 420,
    });
    metrics.recordCompactionRun({
      conversationId: "conv-observe",
      sessionId: "session-observe",
      compactionId: "cmp-1",
      triggerReason: "manual",
      tokenBefore: 420,
      tokenAfter: 180,
    });
    metrics.recordSummaryCreated({
      conversationId: "conv-observe",
      sessionId: "session-observe",
      compactionId: "cmp-1",
      summaryId: "sum-1",
      kind: "leaf",
    });
    metrics.recordExpandLatency({
      conversationId: "conv-observe",
      sessionId: "session-observe",
      latencyMs: 12,
      depth: 2,
      truncated: false,
      resultCount: 3,
    });
    metrics.recordSearchLatency({
      conversationId: "conv-observe",
      sessionId: "session-observe",
      latencyMs: 8,
      mode: "full_text",
      scope: "both",
      scannedCount: 14,
      resultCount: 4,
    });
    metrics.recordIntegrityFailure({
      conversationId: "conv-observe",
      sessionId: "session-observe",
      code: "summary_without_source",
      severity: "error",
      fixable: false,
    });

    const snapshot = metrics.snapshot();
    expect(snapshot.context_tokens.samples).toBe(1);
    expect(snapshot.context_tokens.total).toBe(420);
    expect(snapshot.compaction_runs).toBe(1);
    expect(snapshot.summaries_created).toBe(1);
    expect(snapshot.summaries_created_by_kind.leaf).toBe(1);
    expect(snapshot.expand_latency_ms.count).toBe(1);
    expect(snapshot.search_latency_ms.count).toBe(1);
    expect(snapshot.integrity_failures).toBe(1);
    expect(snapshot.recent_events.length).toBe(6);

    const compactionEvent = events.find((event) => event.event === "compaction_run");
    expect(compactionEvent).toMatchObject({
      conversation_id: "conv-observe",
      session_id: "session-observe",
      compaction_id: "cmp-1",
      trigger_reason: "manual",
      token_before: 420,
      token_after: 180,
    });
  });

  it("captures metrics emitted by compaction and retrieval engines", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lcm-observability-"));
    OPEN_DIRS.add(dir);

    const backend = createSqliteLcmStorageBackend({
      dbPath: path.join(dir, "lcm.sqlite"),
    });
    OPEN_BACKENDS.add(backend);
    await backend.migrate();

    const metrics = createLcmMetrics();
    const tokenEstimator = createPlaceholderTokenEstimator();
    const store = createConversationStore({ storage: backend });
    const compaction = createCompactionEngine({
      store,
      tokenEstimator,
      metrics,
      leafBatchSize: 4,
    });
    const retrieval = createLcmRetrievalEngine({
      backend,
      tokenEstimator,
      metrics,
    });
    const conversationId = "conv-observability-engine" as ConversationId;

    const messages: AgentMessage[] = [
      { role: "user", content: "What failed in deploy?" },
      { role: "assistant", content: "The migration step failed." },
      { role: "user", content: "Summarize root causes." },
      { role: "assistant", content: "Root causes were lock contention and stale config." },
      { role: "user", content: "Any regressions from retry policy?" },
      { role: "assistant", content: "No regressions reported." },
    ];

    await ingestCanonicalTranscript({
      store,
      tokenEstimator,
      conversationId,
      sessionId: "session-observability",
      provider: "openai",
      modelId: "gpt-5",
      baseNowMs: 1_800_000_000_000,
      messages,
    });

    const compactionResult = await compaction.compact({
      conversationId,
      assembledTokens: 9_000,
      modelTokenBudget: 4_000,
      contextThreshold: 0.8,
      maxActiveMessages: 100,
      targetTokens: 50,
      freshTailCount: 1,
      manual: true,
    });
    expect(compactionResult.compacted).toBe(true);

    const grepResult = await retrieval.grep({
      query: "root causes",
      mode: "full_text",
      scope: "both",
      conversationId,
      limit: 10,
    });
    expect(grepResult.matches.length).toBeGreaterThan(0);

    const expandSummaryId = compactionResult.summaries[0]?.id;
    expect(expandSummaryId).toBeDefined();
    await retrieval.expand({
      summaryId: expandSummaryId,
      depth: 2,
      limit: 20,
      tokenCap: 3_000,
    });

    const snapshot = metrics.snapshot();
    expect(snapshot.compaction_runs).toBeGreaterThanOrEqual(1);
    expect(snapshot.summaries_created).toBeGreaterThanOrEqual(1);
    expect(snapshot.context_tokens.samples).toBeGreaterThanOrEqual(2);
    expect(snapshot.search_latency_ms.count).toBe(1);
    expect(snapshot.expand_latency_ms.count).toBe(1);
  });
});
