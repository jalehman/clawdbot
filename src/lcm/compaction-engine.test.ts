import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId, MessageId, SummaryId } from "./types.js";
import { createCompactionEngine } from "./compaction-engine.js";
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

describe("createCompactionEngine", () => {
  it("evaluates manual, token, and message-count triggers", async () => {
    const { engine, store } = await createFixture();
    const conversationId = "conv-compact-eval" as ConversationId;

    await seedMessages({ store, conversationId, count: 5, baseNowMs: 10_000 });

    const tokenDecision = await engine.evaluate({
      conversationId,
      assembledTokens: 950,
      modelTokenBudget: 1_000,
      contextThreshold: 0.9,
      maxActiveMessages: 20,
    });
    expect(tokenDecision.shouldCompact).toBe(true);
    expect(tokenDecision.reason).toBe("token_threshold");

    const countDecision = await engine.evaluate({
      conversationId,
      assembledTokens: 10,
      modelTokenBudget: 1_000,
      contextThreshold: 0.95,
      maxActiveMessages: 3,
    });
    expect(countDecision.shouldCompact).toBe(true);
    expect(countDecision.reason).toBe("message_threshold");

    const manualDecision = await engine.evaluate({
      conversationId,
      assembledTokens: 1,
      modelTokenBudget: 10_000,
      contextThreshold: 0.99,
      maxActiveMessages: 99,
      manual: true,
    });
    expect(manualDecision.shouldCompact).toBe(true);
    expect(manualDecision.reason).toBe("manual");
  });

  it("compacts oldest raw turns while preserving the configured fresh tail", async () => {
    const { engine, store, backend } = await createFixture();
    const conversationId = "conv-compact-fresh-tail" as ConversationId;

    await seedMessages({
      store,
      conversationId,
      count: 8,
      baseNowMs: 20_000,
      contentPrefix: "Build diagnostics and traces",
    });

    const result = await engine.compact({
      conversationId,
      assembledTokens: 2_000,
      modelTokenBudget: 1_000,
      contextThreshold: 0.8,
      maxActiveMessages: 50,
      targetTokens: 120,
      freshTailCount: 2,
    });

    expect(result.compacted).toBe(true);
    expect(result.batches.leaf).toBeGreaterThan(0);

    const activeMessageItems = await store.getContextItems({
      conversationId,
      itemTypes: ["message"],
      includeTombstoned: false,
      limit: 100,
    });
    expect(activeMessageItems).toHaveLength(2);

    const activeMessageIds = activeMessageItems
      .map((item) => item.sourceMessageId)
      .filter((value): value is MessageId => Boolean(value));
    const activeMessages = await store.listMessages({
      conversationId,
      messageIds: activeMessageIds,
      limit: activeMessageIds.length,
    });
    expect(activeMessages.map((message) => message.ordinal)).toEqual([6, 7]);

    const canonicalMessageCount = backend.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM lcm_messages WHERE conversation_id = ?",
      [conversationId],
    );
    expect(canonicalMessageCount?.count).toBe(8);
  });

  it("runs condensed pass by merging adjacent stale leaf summaries", async () => {
    const { engine, store } = await createFixture();
    const conversationId = "conv-compact-condensed" as ConversationId;

    const ingest = await seedMessages({
      store,
      conversationId,
      count: 6,
      baseNowMs: 30_000,
      contentPrefix: "Historical context message",
    });

    const ids = ingest.persistedMessageIds;
    await createLeafSummaryFromRange({
      store,
      conversationId,
      summaryId: "sum-leaf-a" as SummaryId,
      messageIds: [ids[0], ids[1]].filter((value): value is MessageId => Boolean(value)),
      createdAtMs: 29_900,
    });
    await createLeafSummaryFromRange({
      store,
      conversationId,
      summaryId: "sum-leaf-b" as SummaryId,
      messageIds: [ids[2], ids[3]].filter((value): value is MessageId => Boolean(value)),
      createdAtMs: 29_901,
    });

    const result = await engine.compact({
      conversationId,
      assembledTokens: 5,
      modelTokenBudget: 100_000,
      contextThreshold: 0.95,
      maxActiveMessages: 500,
      targetTokens: 10_000,
      freshTailCount: 2,
      manual: true,
    });

    expect(result.compacted).toBe(true);
    expect(result.batches.condensed).toBeGreaterThan(0);

    const activeSummaries = await store.getContextItems({
      conversationId,
      itemTypes: ["summary"],
      includeTombstoned: false,
      limit: 50,
    });
    const kinds = activeSummaries.map((item) => String(item.metadata?.kind ?? ""));
    expect(kinds).toContain("condensed");
  });

  it("serializes concurrent compaction calls per conversation", async () => {
    const { engine, store } = await createFixture();
    const conversationId = "conv-compact-concurrent" as ConversationId;

    await seedMessages({
      store,
      conversationId,
      count: 8,
      baseNowMs: 40_000,
      contentPrefix: "Concurrent compact message",
    });

    const request = {
      conversationId,
      assembledTokens: 10,
      modelTokenBudget: 10_000,
      contextThreshold: 0.95,
      maxActiveMessages: 500,
      targetTokens: 10_000,
      freshTailCount: 2,
      manual: true,
    } as const;

    const [first, second] = await Promise.all([engine.compact(request), engine.compact(request)]);

    expect(first.compacted || second.compacted).toBe(true);

    const activeSummaries = await store.getContextItems({
      conversationId,
      itemTypes: ["summary"],
      includeTombstoned: false,
      limit: 50,
    });
    const leafSummaryCount = activeSummaries.filter((item) => item.metadata.kind === "leaf").length;
    expect(leafSummaryCount).toBe(1);
  });
});

async function createFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lcm-compaction-engine-"));
  OPEN_DIRS.add(dir);

  const backend = createSqliteLcmStorageBackend({
    dbPath: path.join(dir, "lcm.sqlite"),
  });
  OPEN_BACKENDS.add(backend);
  await backend.migrate();

  const store = createConversationStore({ storage: backend });
  const engine = createCompactionEngine({
    store,
    tokenEstimator: createPlaceholderTokenEstimator(),
    leafBatchSize: 6,
    condensedBatchSize: 3,
  });

  return { backend, store, engine };
}

async function seedMessages(params: {
  store: ReturnType<typeof createConversationStore>;
  conversationId: ConversationId;
  count: number;
  baseNowMs: number;
  contentPrefix?: string;
}) {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < params.count; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    messages.push({
      role,
      content: `${params.contentPrefix ?? "Message"} ${index + 1}`,
    });
  }

  return ingestCanonicalTranscript({
    store: params.store,
    tokenEstimator: createPlaceholderTokenEstimator(),
    conversationId: params.conversationId,
    sessionId: String(params.conversationId),
    provider: "openai",
    modelId: "gpt-5",
    baseNowMs: params.baseNowMs,
    messages,
  });
}

async function createLeafSummaryFromRange(params: {
  store: ReturnType<typeof createConversationStore>;
  conversationId: ConversationId;
  summaryId: SummaryId;
  messageIds: MessageId[];
  createdAtMs: number;
}) {
  const firstMessageId = params.messageIds[0];
  const lastMessageId = params.messageIds[params.messageIds.length - 1];
  if (!firstMessageId || !lastMessageId) {
    throw new Error("leaf summary requires at least two message ids");
  }

  await params.store.insertSummary({
    summaryId: params.summaryId,
    conversationId: params.conversationId,
    sourceMessageId: firstMessageId,
    depth: 1,
    title: `Leaf ${params.summaryId}`,
    body: `Leaf summary for ${params.summaryId}`,
    metadata: { kind: "leaf" },
    createdAtMs: params.createdAtMs,
  });

  await params.store.linkSummaryToMessages({
    conversationId: params.conversationId,
    summaryId: params.summaryId,
    messageIds: params.messageIds,
    createdAtMs: params.createdAtMs + 1,
  });

  const messageItems = await params.store.getContextItems({
    conversationId: params.conversationId,
    itemTypes: ["message"],
    includeTombstoned: false,
    limit: 200,
  });

  const startItem = messageItems.find((item) => item.sourceMessageId === firstMessageId);
  const endItem = messageItems.find((item) => item.sourceMessageId === lastMessageId);
  if (!startItem || !endItem) {
    throw new Error("unable to locate context-item bounds for leaf summary");
  }

  await params.store.replaceContextRangeWithSummary({
    conversationId: params.conversationId,
    summaryId: params.summaryId,
    startItemId: startItem.itemId,
    endItemId: endItem.itemId,
    metadata: { kind: "leaf" },
    updatedAtMs: params.createdAtMs + 2,
  });
}
