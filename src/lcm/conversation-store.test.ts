import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "../plugins/types.js";
import type { ConversationId, SummaryId } from "./types.js";
import { clearContextEngineRegistry, selectContextEngine } from "../context-engine/index.js";
import { createConversationStore } from "./conversation-store.js";
import { ingestCanonicalTranscript, resolveConversationId } from "./ingestion.js";
import lcmPlugin from "./plugin.js";
import { createSqliteLcmStorageBackend } from "./storage/sqlite.js";
import { createPlaceholderTokenEstimator } from "./token-estimator.js";

const OPEN_BACKENDS = new Set<{
  close: () => Promise<void>;
}>();
const OPEN_DIRS = new Set<string>();
const PREVIOUS_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

afterEach(async () => {
  clearContextEngineRegistry();
  process.env.OPENCLAW_STATE_DIR = PREVIOUS_STATE_DIR;

  for (const backend of OPEN_BACKENDS) {
    await backend.close();
  }
  OPEN_BACKENDS.clear();

  for (const dir of OPEN_DIRS) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  OPEN_DIRS.clear();
});

describe("SqliteConversationStore", () => {
  it("ingests transcripts idempotently with deterministic ordering", async () => {
    const { store, backend } = await createFixture();
    const conversationId = "session-idempotent" as ConversationId;
    const messages = sampleTranscript();

    const first = await ingestCanonicalTranscript({
      store,
      tokenEstimator: createPlaceholderTokenEstimator(),
      conversationId,
      sessionId: "session-idempotent",
      channel: "telegram",
      provider: "anthropic",
      modelId: "claude",
      messages,
      baseNowMs: 1_000,
    });
    const second = await ingestCanonicalTranscript({
      store,
      tokenEstimator: createPlaceholderTokenEstimator(),
      conversationId,
      sessionId: "session-idempotent",
      channel: "telegram",
      provider: "anthropic",
      modelId: "claude",
      messages,
      baseNowMs: 2_000,
    });

    expect(second.persistedMessageIds).toEqual(first.persistedMessageIds);

    const messageRows = backend.all<{ ordinal: number; message_id: string }>(
      `SELECT ordinal, message_id
       FROM lcm_messages
       WHERE conversation_id = ?
       ORDER BY ordinal ASC`,
      [conversationId],
    );
    expect(messageRows.map((row) => row.ordinal)).toEqual([0, 1, 2, 3]);
    expect(messageRows.map((row) => row.message_id)).toEqual(first.persistedMessageIds);

    const messageCount = backend.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM lcm_messages WHERE conversation_id = ?",
      [conversationId],
    );
    const partCount = backend.get<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM lcm_message_parts p
       INNER JOIN lcm_messages m ON m.message_id = p.message_id
       WHERE m.conversation_id = ?`,
      [conversationId],
    );
    const contextCount = backend.get<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM lcm_context_items
       WHERE conversation_id = ? AND item_type = 'message'`,
      [conversationId],
    );
    expect(messageCount?.count).toBe(messages.length);
    expect(partCount?.count).toBeGreaterThanOrEqual(messages.length);
    expect(contextCount?.count).toBe(messages.length);
  });

  it("stores summary lineage and resolves summary message ancestry", async () => {
    const { store } = await createFixture();
    const conversationId = "session-summary-lineage" as ConversationId;
    const ingest = await ingestCanonicalTranscript({
      store,
      tokenEstimator: createPlaceholderTokenEstimator(),
      conversationId,
      sessionId: "session-summary-lineage",
      provider: "openai",
      modelId: "gpt",
      messages: sampleTranscript(),
      baseNowMs: 10_000,
    });

    const parentSummaryId = "sum-parent" as SummaryId;
    const childSummaryId = "sum-child" as SummaryId;
    await store.insertSummary({
      summaryId: parentSummaryId,
      conversationId,
      body: "Earlier conversation themes",
      createdAtMs: 11_000,
    });
    await store.insertSummary({
      summaryId: childSummaryId,
      conversationId,
      body: "Recent tools and results",
      createdAtMs: 12_000,
    });
    await store.linkSummaryToMessages({
      conversationId,
      summaryId: childSummaryId,
      messageIds: ingest.persistedMessageIds.slice(0, 2),
      createdAtMs: 12_100,
    });
    await store.linkSummaryToParents({
      summaryId: childSummaryId,
      parentSummaryIds: [parentSummaryId],
      createdAtMs: 12_200,
    });

    const fetched = await store.getSummary(childSummaryId);
    const children = await store.getSummaryChildren(parentSummaryId);
    const summaryMessages = await store.getSummaryMessages(childSummaryId);
    expect(fetched?.body).toContain("Recent tools");
    expect(children.map((item) => item.itemId)).toEqual([childSummaryId]);
    expect(summaryMessages.map((row) => row.ordinal)).toEqual([0, 1]);
  });

  it("tombstones a context range when compacted into a summary", async () => {
    const { store, backend } = await createFixture();
    const conversationId = "session-compaction" as ConversationId;
    await ingestCanonicalTranscript({
      store,
      tokenEstimator: createPlaceholderTokenEstimator(),
      conversationId,
      sessionId: "session-compaction",
      provider: "openai",
      modelId: "gpt",
      messages: sampleTranscript(),
      baseNowMs: 20_000,
    });

    const items = await store.getContextItems({ conversationId });
    expect(items.length).toBeGreaterThanOrEqual(2);
    const startItem = items[0];
    const endItem = items[1];
    if (!startItem || !endItem) {
      throw new Error("expected at least 2 context items");
    }
    const summaryId = "sum-compact" as SummaryId;
    await store.insertSummary({
      summaryId,
      conversationId,
      body: "Compacted first two entries",
      createdAtMs: 25_000,
    });
    const replaced = await store.replaceContextRangeWithSummary({
      conversationId,
      summaryId,
      startItemId: startItem.itemId,
      endItemId: endItem.itemId,
      updatedAtMs: 25_050,
    });
    expect(replaced).toBe(2);

    const activeItems = await store.getContextItems({ conversationId });
    const tombstonedCount = backend.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM lcm_context_items WHERE conversation_id = ? AND tombstoned = 1",
      [conversationId],
    );
    const compactedEdges = backend.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM lcm_lineage_edges WHERE child_item_id = ? AND relation = 'compacted'",
      [summaryId],
    );
    expect(activeItems.some((item) => item.itemId === summaryId)).toBe(true);
    expect(tombstonedCount?.count).toBe(2);
    expect(compactedEdges?.count).toBe(2);
  });

  it("searches canonical messages and summaries", async () => {
    const { store } = await createFixture();
    const conversationId = "session-search" as ConversationId;
    const ingest = await ingestCanonicalTranscript({
      store,
      tokenEstimator: createPlaceholderTokenEstimator(),
      conversationId,
      sessionId: "session-search",
      provider: "anthropic",
      modelId: "claude",
      messages: [
        { role: "user", content: "Tell me about walrus migrations." } as AgentMessage,
        {
          role: "assistant",
          content: [{ type: "text", text: "Walrus pods migrate north." }],
        } as AgentMessage,
      ],
      baseNowMs: 30_000,
    });

    const summaryId = "sum-search" as SummaryId;
    await store.insertSummary({
      summaryId,
      conversationId,
      body: "Walrus migration summary and habitat notes.",
      createdAtMs: 31_000,
    });
    const firstMessageId = ingest.persistedMessageIds[0];
    if (!firstMessageId) {
      throw new Error("expected first message id");
    }
    await store.linkSummaryToMessages({
      conversationId,
      summaryId,
      messageIds: [firstMessageId],
      createdAtMs: 31_100,
    });

    const messageHits = await store.searchMessages({
      conversationId,
      query: "walrus",
      limit: 10,
    });
    const summaryHits = await store.searchSummaries({
      conversationId,
      query: "habitat",
      limit: 10,
    });
    expect(messageHits.length).toBeGreaterThan(0);
    const firstMessageHit = messageHits[0];
    if (!firstMessageHit) {
      throw new Error("expected at least one message hit");
    }
    expect(firstMessageHit.snippet.toLowerCase()).toContain("walrus");
    expect(summaryHits.some((hit) => hit.summaryId === summaryId)).toBe(true);
  });
});

describe("LCM plugin ingest", () => {
  it("wires context-engine ingest to canonical persistence", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lcm-plugin-"));
    OPEN_DIRS.add(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const api = buildMockPluginApi();
    await lcmPlugin.register?.(api);
    const { engine } = selectContextEngine("lcm");
    const result = await engine.ingest({
      sessionId: "plugin-session",
      provider: "openai",
      modelId: "gpt-5",
      messages: sampleTranscript(),
      meta: { messageChannel: "discord" },
    });

    const lcmMeta = (result.meta?.lcm ?? {}) as { phase?: string; persistedMessages?: number };
    expect(lcmMeta.phase).toBe("ingest");
    expect(lcmMeta.persistedMessages).toBe(4);

    const dbPath = path.join(stateDir, "lcm", "lcm.sqlite");
    const backend = createSqliteLcmStorageBackend({ dbPath });
    OPEN_BACKENDS.add(backend);
    await backend.migrate();
    const count = backend.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM lcm_messages WHERE conversation_id = ?",
      [resolveConversationId("plugin-session")],
    );
    expect(count?.count).toBe(4);
  });
});

function sampleTranscript(): AgentMessage[] {
  return [
    { role: "user", content: "Summarize the latest build logs." } as AgentMessage,
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect the logs." },
        { type: "toolCall", id: "call_1", name: "read_logs", arguments: { lines: 100 } },
      ],
    } as AgentMessage,
    {
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: "Build finished with 2 warnings." }],
    } as AgentMessage,
    { role: "assistant", content: "Warnings are in lint and docs checks." } as AgentMessage,
  ];
}

async function createFixture(): Promise<{
  store: ReturnType<typeof createConversationStore>;
  backend: ReturnType<typeof createSqliteLcmStorageBackend>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lcm-store-"));
  OPEN_DIRS.add(dir);
  const backend = createSqliteLcmStorageBackend({
    dbPath: path.join(dir, "lcm.sqlite"),
  });
  OPEN_BACKENDS.add(backend);
  await backend.migrate();
  return {
    store: createConversationStore({ storage: backend }),
    backend,
  };
}

function buildMockPluginApi(): OpenClawPluginApi {
  return {
    id: "lcm",
    name: "lcm",
    source: "test",
    config: {} as OpenClawPluginApi["config"],
    pluginConfig: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    registerTool() {},
    registerHook() {},
    registerHttpHandler() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    resolvePath(input: string) {
      return input;
    },
    on() {},
  };
}
