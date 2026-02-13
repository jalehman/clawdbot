import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId, SummaryId } from "./types.js";
import { createCompactionEngine } from "./compaction-engine.js";
import { createContextAssembler } from "./context-assembler.js";
import { createConversationStore } from "./conversation-store.js";
import { ingestCanonicalTranscript } from "./ingestion.js";
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

describe("LCM end-to-end pipeline", () => {
  it("runs ingest -> assemble -> compact -> retrieve/expand with >=30% token reduction", async () => {
    const { backend, store, assembler, compaction, retrieval } = await createHarness(
      "openclaw-lcm-e2e-pipeline-",
    );
    const conversationId = "conv-e2e-pipeline" as ConversationId;

    const transcript = buildTranscript({
      marker: "anchorrollback",
      topic: "deployment regression",
      turnCount: 10,
    });

    const ingest = await ingestCanonicalTranscript({
      store,
      tokenEstimator: createPlaceholderTokenEstimator(),
      conversationId,
      sessionId: "conv-e2e-pipeline",
      provider: "openai",
      modelId: "gpt-5",
      baseNowMs: 1_800_000_000_000,
      messages: transcript,
    });

    const assembledBefore = await assembler.assemble({
      conversationId,
      targetTokens: 50_000,
      freshTailCount: 2,
    });

    const compactionResult = await compaction.compact({
      conversationId,
      assembledTokens: assembledBefore.tokenEstimate,
      modelTokenBudget: 2_000,
      contextThreshold: 0.8,
      maxActiveMessages: 100,
      targetTokens: Math.floor(assembledBefore.tokenEstimate * 0.6),
      freshTailCount: 2,
      manual: true,
      customInstructions: "Preserve incident timeline details.",
    });

    expect(compactionResult.compacted).toBe(true);
    expect(compactionResult.tokensAfter).toBeLessThanOrEqual(
      Math.floor(compactionResult.tokensBefore * 0.7),
    );

    const assembledAfter = await assembler.assemble({
      conversationId,
      targetTokens: 50_000,
      freshTailCount: 2,
    });
    expect(assembledAfter.summaries.length).toBeGreaterThan(0);

    const activeSummaries = await store.getContextItems({
      conversationId,
      itemTypes: ["summary"],
      includeTombstoned: false,
      limit: 100,
    });
    const firstSummary = activeSummaries[0];
    if (!firstSummary) {
      throw new Error("expected at least one active summary after compaction");
    }

    await wireSummaryToSourceMessages({
      backend,
      store,
      conversationId,
      summaryId: firstSummary.itemId as SummaryId,
      nowMs: 1_800_000_009_999,
    });

    const described = await retrieval.describe(firstSummary.itemId);
    expect(described?.kind).toBe("summary");
    if (!described || described.kind !== "summary") {
      throw new Error("expected summary describe result");
    }
    expect(described.sourceMessageRange?.count ?? 0).toBeGreaterThan(0);

    const expanded = await retrieval.expand({
      summaryId: firstSummary.itemId as SummaryId,
      depth: 1,
      includeMessages: true,
      tokenCap: 15_000,
      limit: 60,
    });

    expect(expanded.messages.length).toBeGreaterThan(0);
    expect(
      expanded.messages.every((message) => ingest.persistedMessageIds.includes(message.id)),
    ).toBe(true);

    const search = await retrieval.grep({
      query: "anchorrollback",
      mode: "full_text",
      scope: "both",
      conversationId,
      limit: 50,
    });
    const matchKinds = new Set(search.matches.map((match) => match.kind));
    expect(matchKinds.has("message")).toBe(true);
    expect(matchKinds.has("summary")).toBe(true);
  });

  it("supports interleaved multi-conversation ingest/compaction with scoped retrieval", async () => {
    const { assembler, compaction, retrieval, store } =
      await createHarness("openclaw-lcm-e2e-multi-");
    const alphaId = "conv-e2e-alpha" as ConversationId;
    const betaId = "conv-e2e-beta" as ConversationId;

    await ingestCanonicalTranscript({
      store,
      tokenEstimator: createPlaceholderTokenEstimator(),
      conversationId: alphaId,
      sessionId: "conv-e2e-alpha",
      provider: "openai",
      modelId: "gpt-5",
      baseNowMs: 1_800_000_100_000,
      messages: buildTranscript({
        marker: "alphasignal",
        topic: "alpha diagnostics",
        turnCount: 8,
      }),
    });
    await ingestCanonicalTranscript({
      store,
      tokenEstimator: createPlaceholderTokenEstimator(),
      conversationId: betaId,
      sessionId: "conv-e2e-beta",
      provider: "anthropic",
      modelId: "claude",
      baseNowMs: 1_800_000_100_500,
      messages: buildTranscript({
        marker: "betasignal",
        topic: "beta diagnostics",
        turnCount: 8,
      }),
    });

    const [alphaAssembled, betaAssembled] = await Promise.all([
      assembler.assemble({
        conversationId: alphaId,
        targetTokens: 60_000,
        freshTailCount: 2,
      }),
      assembler.assemble({
        conversationId: betaId,
        targetTokens: 60_000,
        freshTailCount: 2,
      }),
    ]);

    const alphaCompaction = await compaction.compact({
      conversationId: alphaId,
      assembledTokens: alphaAssembled.tokenEstimate,
      modelTokenBudget: 2_000,
      contextThreshold: 0.8,
      maxActiveMessages: 100,
      targetTokens: Math.floor(alphaAssembled.tokenEstimate * 0.65),
      freshTailCount: 2,
      manual: true,
    });
    const betaCompaction = await compaction.compact({
      conversationId: betaId,
      assembledTokens: betaAssembled.tokenEstimate,
      modelTokenBudget: 2_000,
      contextThreshold: 0.8,
      maxActiveMessages: 100,
      targetTokens: Math.floor(betaAssembled.tokenEstimate * 0.65),
      freshTailCount: 2,
      manual: true,
    });

    expect(alphaCompaction.compacted).toBe(true);
    expect(betaCompaction.compacted).toBe(true);

    const alphaSearch = await retrieval.grep({
      query: "alphasignal",
      mode: "full_text",
      scope: "both",
      conversationId: alphaId,
      limit: 20,
    });
    expect(alphaSearch.matches.length).toBeGreaterThan(0);
    expect(alphaSearch.matches.every((match) => match.conversationId === alphaId)).toBe(true);

    const betaSearchFromAlphaScope = await retrieval.grep({
      query: "betasignal",
      mode: "full_text",
      scope: "both",
      conversationId: alphaId,
      limit: 20,
    });
    expect(betaSearchFromAlphaScope.matches).toHaveLength(0);

    const globalSearch = await retrieval.grep({
      query: "signal",
      mode: "full_text",
      scope: "messages",
      limit: 100,
    });
    const conversationIds = new Set(globalSearch.matches.map((match) => match.conversationId));
    expect(conversationIds.has(alphaId)).toBe(true);
    expect(conversationIds.has(betaId)).toBe(true);
  });
});

async function createHarness(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  OPEN_DIRS.add(dir);

  const backend = createSqliteLcmStorageBackend({
    dbPath: path.join(dir, "lcm.sqlite"),
  });
  OPEN_BACKENDS.add(backend);
  await backend.migrate();

  const tokenEstimator = createPlaceholderTokenEstimator();
  const store = createConversationStore({ storage: backend });
  const assembler = createContextAssembler({
    store,
    tokenEstimator,
  });
  const compaction = createCompactionEngine({
    store,
    tokenEstimator,
    leafBatchSize: 6,
    condensedBatchSize: 3,
  });
  const retrieval = createLcmRetrievalEngine({
    backend,
    tokenEstimator,
  });

  return { backend, store, assembler, compaction, retrieval };
}

function buildTranscript(params: {
  marker: string;
  topic: string;
  turnCount: number;
}): AgentMessage[] {
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: `Policy: keep answers factual while tracking ${params.topic}.`,
    } as AgentMessage,
  ];

  for (let index = 0; index < params.turnCount; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    messages.push({
      role,
      content: buildLongTurnText({
        marker: params.marker,
        topic: params.topic,
        index,
      }),
    } as AgentMessage);
  }

  return messages;
}

function buildLongTurnText(params: { marker: string; topic: string; index: number }): string {
  const intro = `Turn ${params.index + 1} on ${params.topic} references ${params.marker}.`;
  const details = [
    "Timeline includes ingestion checkpoints, replay logs, and rollout notes.",
    "Each checkpoint records actor, subsystem, and mitigation reasoning.",
    "Investigation preserves source ids so future retrieval can trace exact evidence.",
    "Cross-team handoff retained the same marker for regression correlation.",
  ].join(" ");
  return `${intro} ${details} ${details} ${details}`;
}

async function wireSummaryToSourceMessages(params: {
  backend: ReturnType<typeof createSqliteLcmStorageBackend>;
  store: ReturnType<typeof createConversationStore>;
  conversationId: ConversationId;
  summaryId: SummaryId;
  nowMs: number;
}) {
  const sourceMessages = await params.store.getSummaryMessages(params.summaryId, 50);
  for (let index = 0; index < sourceMessages.length; index += 1) {
    const message = sourceMessages[index];
    if (!message) {
      continue;
    }

    let contextItem = params.backend.get<{ item_id: string }>(
      `SELECT item_id
       FROM lcm_context_items
       WHERE conversation_id = ?
         AND item_type = 'message'
         AND source_message_id = ?
         AND tombstoned = 0
       ORDER BY created_at_ms ASC
       LIMIT 1`,
      [params.conversationId, message.messageId],
    );
    if (!contextItem) {
      const syntheticItemId = `ctxtrace_${String(params.summaryId).slice(0, 12)}_${index + 1}`;
      params.backend.execute(
        `INSERT OR IGNORE INTO lcm_context_items (
          item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'message', 1, ?, ?, ?, 0, ?, ?)`,
        [
          syntheticItemId,
          params.conversationId,
          message.messageId,
          `Trace ${index + 1}`,
          `Synthetic trace node for ${message.messageId}`,
          JSON.stringify({ source: "e2e-trace" }),
          params.nowMs + index,
          params.nowMs + index,
        ],
      );
      contextItem = { item_id: syntheticItemId };
    }

    params.backend.execute(
      `INSERT OR IGNORE INTO lcm_lineage_edges (parent_item_id, child_item_id, relation, metadata_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      [params.summaryId, contextItem.item_id, "derived", "{}", params.nowMs],
    );
  }
}
