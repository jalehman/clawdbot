import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId, SummaryId } from "./types.js";
import { createContextAssembler } from "./context-assembler.js";
import { createConversationStore } from "./conversation-store.js";
import { ingestCanonicalTranscript } from "./ingestion.js";
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

describe("createContextAssembler", () => {
  it("keeps policy content first and preserves fresh-tail chronological order", async () => {
    const { store, assembler } = await createFixture();
    const conversationId = "conv-assemble-fresh-tail" as ConversationId;

    await ingestCanonicalTranscript({
      store,
      tokenEstimator: createPlaceholderTokenEstimator(),
      conversationId,
      sessionId: "conv-assemble-fresh-tail",
      provider: "openai",
      modelId: "gpt-5",
      baseNowMs: 10_000,
      messages: [
        { role: "system", content: "Policy: never reveal secrets." },
        { role: "user", content: "Earlier user question." },
        { role: "assistant", content: "Earlier assistant response." },
        { role: "user", content: "Fresh question about build output." },
        { role: "assistant", content: "Fresh answer with latest diagnostics." },
      ] as AgentMessage[],
    });

    const result = await assembler.assemble({
      conversationId,
      targetTokens: 120,
      freshTailCount: 2,
    });

    expect(result.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
    expect(result.messages.map((message) => message.content)).toEqual([
      "Policy: never reveal secrets.",
      "Fresh question about build output.",
      "Fresh answer with latest diagnostics.",
    ]);
    expect(result.tokenEstimate).toBeLessThanOrEqual(120);
  });

  it("enforces token budget for summaries while ranking by relevance and recency", async () => {
    const { store, assembler } = await createFixture();
    const conversationId = "conv-assemble-summaries" as ConversationId;

    const ingest = await ingestCanonicalTranscript({
      store,
      tokenEstimator: createPlaceholderTokenEstimator(),
      conversationId,
      sessionId: "conv-assemble-summaries",
      provider: "openai",
      modelId: "gpt-5",
      baseNowMs: 20_000,
      messages: [
        { role: "system", content: "Policy: concise and factual." },
        { role: "user", content: "Old logs mention memory pressure and cache churn." },
        { role: "assistant", content: "We should inspect compaction backlog metrics." },
        { role: "user", content: "Fresh: compaction backlog increased after deploy." },
        { role: "assistant", content: "Fresh: root cause points to vacuum lag." },
      ] as AgentMessage[],
    });

    const relevantSummaryId = "sum-relevant" as SummaryId;
    const unrelatedSummaryId = "sum-unrelated" as SummaryId;

    await store.insertSummary({
      summaryId: relevantSummaryId,
      conversationId,
      title: "Compaction findings",
      body: "Compaction backlog and vacuum lag were visible before deploy.",
      metadata: { kind: "leaf" },
      createdAtMs: 19_800,
    });
    await store.linkSummaryToMessages({
      conversationId,
      summaryId: relevantSummaryId,
      messageIds: ingest.persistedMessageIds.slice(0, 2),
      createdAtMs: 19_801,
    });

    await store.insertSummary({
      summaryId: unrelatedSummaryId,
      conversationId,
      title: "Weekend plans",
      body: "Team discussed brunch and bike routes.",
      metadata: { kind: "leaf" },
      createdAtMs: 19_700,
    });
    await store.linkSummaryToMessages({
      conversationId,
      summaryId: unrelatedSummaryId,
      messageIds: ingest.persistedMessageIds.slice(0, 2),
      createdAtMs: 19_701,
    });

    const result = await assembler.assemble({
      conversationId,
      targetTokens: 55,
      freshTailCount: 2,
    });

    expect(result.summaries.length).toBeGreaterThan(0);
    expect(result.summaries[0]?.id).toBe(relevantSummaryId);
    expect(result.summaries.some((summary) => summary.id === unrelatedSummaryId)).toBe(false);
    expect(result.tokenEstimate).toBeLessThanOrEqual(55);
  });
});

async function createFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lcm-context-assembler-"));
  OPEN_DIRS.add(dir);

  const backend = createSqliteLcmStorageBackend({
    dbPath: path.join(dir, "lcm.sqlite"),
  });
  OPEN_BACKENDS.add(backend);
  await backend.migrate();

  const store = createConversationStore({ storage: backend });
  const assembler = createContextAssembler({
    store,
    tokenEstimator: createPlaceholderTokenEstimator(),
  });

  return { store, assembler };
}
