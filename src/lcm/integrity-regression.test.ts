import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId } from "./types.js";
import { createCompactionEngine } from "./compaction-engine.js";
import { createConversationStore } from "./conversation-store.js";
import { ingestCanonicalTranscript } from "./ingestion.js";
import { createLcmIntegrityChecker, type SqliteLcmIntegrityChecker } from "./integrity-checker.js";
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

describe("LCM integrity regression", () => {
  it("reports zero violations after ingest and compaction cycle", async () => {
    const { checker, compaction, store } = await createHarness("openclaw-lcm-integrity-cycle-");
    const conversationId = "conv-integrity-cycle" as ConversationId;

    await ingestCanonicalTranscript({
      store,
      tokenEstimator: createPlaceholderTokenEstimator(),
      conversationId,
      sessionId: "conv-integrity-cycle",
      provider: "openai",
      modelId: "gpt-5",
      baseNowMs: 1_860_000_000_000,
      messages: buildTranscript("integrity-cycle-marker", 10),
    });

    const compactionResult = await compaction.compact({
      conversationId,
      assembledTokens: 100_000,
      modelTokenBudget: 5_000,
      contextThreshold: 0.8,
      maxActiveMessages: 100,
      targetTokens: 3_000,
      freshTailCount: 2,
      manual: true,
    });
    expect(compactionResult.compacted).toBe(true);

    const report = await checker.scan({ conversationId });
    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  it("detects orphan summaries, broken source refs, and duplicate ordinals", async () => {
    const backend = await createMigratedBackend("openclaw-lcm-integrity-corrupt-");
    const now = 1_860_000_010_000;

    backend.execute(
      `INSERT INTO lcm_conversations (conversation_id, session_id, channel, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      ["conv-corrupt", "conv-corrupt-session", "test", now, now],
    );

    backend.execute(
      `INSERT INTO lcm_context_items (
        item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "sum-orphan",
        "conv-corrupt",
        null,
        "summary",
        0,
        "Orphan summary",
        "No lineage source.",
        "{}",
        0,
        now + 1,
        now + 1,
      ],
    );

    withForeignKeysDisabled(backend, () => {
      backend.execute(
        `INSERT INTO lcm_context_items (
          item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "ctx-broken-message",
          "conv-corrupt",
          "msg-missing-corrupt",
          "message",
          0,
          null,
          "Broken message pointer",
          "{}",
          0,
          now + 2,
          now + 2,
        ],
      );
    });

    const checker = createLcmIntegrityChecker({ backend }) as SqliteLcmIntegrityChecker;
    const report = await checker.scan();
    const codes = new Set(report.violations.map((violation) => violation.code));

    expect(codes.has("summary_without_source")).toBe(true);
    expect(codes.has("context_item_missing_source_message")).toBe(true);
    expect(codes.has("message_context_missing_canonical_message")).toBe(true);

    const duplicateBackend = await createBackendWithDuplicateOrdinals();
    const duplicateChecker = createLcmIntegrityChecker({
      backend: duplicateBackend,
    }) as SqliteLcmIntegrityChecker;
    const duplicateReport = await duplicateChecker.scan();
    const duplicateCodes = new Set(duplicateReport.violations.map((violation) => violation.code));

    expect(duplicateCodes.has("duplicate_message_ordinal")).toBe(true);
    expect(duplicateCodes.has("duplicate_message_part_ordinal")).toBe(true);
  });

  it("repair mode fixes fixable integrity violations while preserving non-fixable findings", async () => {
    const backend = await createMigratedBackend("openclaw-lcm-integrity-repair-reg-");
    const now = 1_860_000_020_000;

    backend.execute(
      `INSERT INTO lcm_conversations (conversation_id, session_id, channel, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      ["conv-repair", "conv-repair-session", "test", now, now],
    );

    backend.execute(
      `INSERT INTO lcm_context_items (
        item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "sum-repair-orphan",
        "conv-repair",
        null,
        "summary",
        0,
        "Still orphaned",
        "Non-fixable summary without lineage.",
        "{}",
        0,
        now + 1,
        now + 1,
      ],
    );

    backend.execute(
      `INSERT INTO lcm_context_items (
        item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "ctx-valid-child",
        "conv-repair",
        null,
        "note",
        0,
        null,
        "Valid child",
        "{}",
        0,
        now + 2,
        now + 2,
      ],
    );

    withForeignKeysDisabled(backend, () => {
      backend.execute(
        `INSERT INTO lcm_context_items (
          item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "ctx-orphan-conversation",
          "conv-missing",
          null,
          "note",
          0,
          null,
          "Missing conversation",
          "{}",
          0,
          now + 3,
          now + 3,
        ],
      );
      backend.execute(
        `INSERT INTO lcm_context_items (
          item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "ctx-note-broken-source",
          "conv-repair",
          "msg-missing-repair",
          "note",
          0,
          null,
          "Broken optional source",
          "{}",
          0,
          now + 4,
          now + 4,
        ],
      );
      backend.execute(
        `INSERT INTO lcm_lineage_edges (parent_item_id, child_item_id, relation, metadata_json, created_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
        ["ctx-missing-parent", "ctx-valid-child", "derived", "{}", now + 5],
      );
    });

    const checker = createLcmIntegrityChecker({ backend }) as SqliteLcmIntegrityChecker;
    const repaired = await checker.scan({ mode: "repair" });

    expect(repaired.preRepairViolationCount).toBeGreaterThan(repaired.violations.length);
    expect(repaired.repairResult?.applied).toBe(repaired.repairPlan.actions.length);
    expect(
      repaired.violations.some((violation) => violation.code === "summary_without_source"),
    ).toBe(true);
    expect(repaired.violations.every((violation) => !violation.fixable)).toBe(true);

    const after = await checker.scan();
    expect(after.violations.every((violation) => !violation.fixable)).toBe(true);
  });

  it("keeps concurrent compaction writes free of partial integrity states", async () => {
    const { backend, checker, compaction, store } = await createHarness(
      "openclaw-lcm-integrity-concurrency-",
    );
    const conversationId = "conv-integrity-concurrency" as ConversationId;

    await ingestCanonicalTranscript({
      store,
      tokenEstimator: createPlaceholderTokenEstimator(),
      conversationId,
      sessionId: "conv-integrity-concurrency",
      provider: "openai",
      modelId: "gpt-5",
      baseNowMs: 1_860_000_030_000,
      messages: buildTranscript("concurrency-marker", 12),
    });

    const request = {
      conversationId,
      assembledTokens: 100_000,
      modelTokenBudget: 5_000,
      contextThreshold: 0.8,
      maxActiveMessages: 200,
      targetTokens: 3_000,
      freshTailCount: 2,
      manual: true,
    } as const;

    const runs = await Promise.all([
      compaction.compact(request),
      compaction.compact(request),
      compaction.compact(request),
      compaction.compact(request),
    ]);

    expect(runs.some((run) => run.compacted)).toBe(true);

    const report = await checker.scan({ conversationId });
    expect(report.ok).toBe(true);

    const tombstonesWithoutEdge = backend.get<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM lcm_context_items ci
       WHERE ci.conversation_id = ?
         AND ci.tombstoned = 1
         AND NOT EXISTS (
           SELECT 1
           FROM lcm_lineage_edges edge
           WHERE edge.parent_item_id = ci.item_id
             AND edge.relation = 'compacted'
         )`,
      [conversationId],
    );

    const summariesWithoutSource = backend.get<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM lcm_context_items summary
       LEFT JOIN lcm_lineage_edges edge ON edge.child_item_id = summary.item_id
       WHERE summary.conversation_id = ?
         AND summary.item_type = 'summary'
       GROUP BY summary.conversation_id
       HAVING COUNT(edge.parent_item_id) = 0`,
      [conversationId],
    );

    expect(tombstonesWithoutEdge?.count ?? 0).toBe(0);
    expect(summariesWithoutSource?.count ?? 0).toBe(0);
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
  const compaction = createCompactionEngine({
    store,
    tokenEstimator,
    leafBatchSize: 6,
    condensedBatchSize: 3,
  });
  const checker = createLcmIntegrityChecker({ backend }) as SqliteLcmIntegrityChecker;

  return { backend, store, compaction, checker };
}

async function createMigratedBackend(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  OPEN_DIRS.add(dir);

  const backend = createSqliteLcmStorageBackend({
    dbPath: path.join(dir, "lcm.sqlite"),
  });
  OPEN_BACKENDS.add(backend);
  await backend.migrate();

  return backend;
}

async function createBackendWithDuplicateOrdinals() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lcm-integrity-duplicates-reg-"));
  OPEN_DIRS.add(dir);

  const dbPath = path.join(dir, "lcm.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(
    `CREATE TABLE lcm_conversations (
      conversation_id TEXT,
      session_id TEXT,
      channel TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    )`,
  );
  db.exec(
    `CREATE TABLE lcm_messages (
      message_id TEXT,
      conversation_id TEXT,
      ordinal INTEGER,
      role TEXT,
      author_id TEXT,
      content_text TEXT,
      payload_json TEXT,
      created_at_ms INTEGER
    )`,
  );
  db.exec(
    `CREATE TABLE lcm_message_parts (
      part_id TEXT,
      message_id TEXT,
      part_index INTEGER,
      kind TEXT,
      mime_type TEXT,
      text_content TEXT,
      blob_path TEXT,
      token_count INTEGER,
      payload_json TEXT,
      created_at_ms INTEGER
    )`,
  );
  db.exec(
    `CREATE TABLE lcm_context_items (
      item_id TEXT,
      conversation_id TEXT,
      source_message_id TEXT,
      item_type TEXT,
      depth INTEGER,
      title TEXT,
      body TEXT,
      metadata_json TEXT,
      tombstoned INTEGER,
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    )`,
  );
  db.exec(
    `CREATE TABLE lcm_lineage_edges (
      parent_item_id TEXT,
      child_item_id TEXT,
      relation TEXT,
      metadata_json TEXT,
      created_at_ms INTEGER
    )`,
  );

  const now = 1_860_000_040_000;
  db.prepare(
    `INSERT INTO lcm_conversations (conversation_id, session_id, channel, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("conv-duplicates", "conv-duplicates-session", "test", now, now);
  db.prepare(
    `INSERT INTO lcm_messages (message_id, conversation_id, ordinal, role, author_id, content_text, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("msg-dup-a", "conv-duplicates", 1, "user", null, "a", "{}", now + 1);
  db.prepare(
    `INSERT INTO lcm_messages (message_id, conversation_id, ordinal, role, author_id, content_text, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("msg-dup-b", "conv-duplicates", 1, "assistant", null, "b", "{}", now + 2);
  db.prepare(
    `INSERT INTO lcm_message_parts (part_id, message_id, part_index, kind, mime_type, text_content, blob_path, token_count, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("part-dup-a", "msg-dup-a", 0, "text", null, "A", null, null, "{}", now + 3);
  db.prepare(
    `INSERT INTO lcm_message_parts (part_id, message_id, part_index, kind, mime_type, text_content, blob_path, token_count, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("part-dup-b", "msg-dup-a", 0, "text", null, "B", null, null, "{}", now + 4);
  db.close();

  const backend = createSqliteLcmStorageBackend({ dbPath });
  OPEN_BACKENDS.add(backend);
  return backend;
}

function buildTranscript(marker: string, turnCount: number): AgentMessage[] {
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: "Policy: preserve canonical evidence ordering.",
    } as AgentMessage,
  ];

  for (let index = 0; index < turnCount; index += 1) {
    messages.push({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Integrity turn ${index + 1} cites ${marker}. Detailed diagnostics remain available for lineage checks.`,
    } as AgentMessage);
  }

  return messages;
}

function withForeignKeysDisabled(
  backend: ReturnType<typeof createSqliteLcmStorageBackend>,
  fn: () => void,
): void {
  backend.execute("PRAGMA foreign_keys = OFF");
  try {
    fn();
  } finally {
    backend.execute("PRAGMA foreign_keys = ON");
  }
}
