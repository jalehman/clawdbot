import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createLcmIntegrityChecker, type SqliteLcmIntegrityChecker } from "./integrity-checker.js";
import { createSqliteLcmStorageBackend } from "./storage/sqlite.js";

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

describe("createLcmIntegrityChecker", () => {
  it("passes a clean database with no violations", async () => {
    const backend = await createMigratedBackend("openclaw-lcm-integrity-clean-");
    const now = 1_900_000_000_000;

    insertConversation(backend, { conversationId: "conv-clean", now });
    insertMessage(backend, {
      messageId: "msg-clean",
      conversationId: "conv-clean",
      ordinal: 1,
      content: "Clean canonical message.",
      now: now + 1,
    });
    insertMessagePart(backend, {
      partId: "part-clean",
      messageId: "msg-clean",
      partIndex: 0,
      now: now + 2,
    });
    insertContextItem(backend, {
      itemId: "ctx-clean-msg",
      conversationId: "conv-clean",
      sourceMessageId: "msg-clean",
      itemType: "message",
      body: "Message pointer",
      now: now + 3,
    });
    insertContextItem(backend, {
      itemId: "sum-clean",
      conversationId: "conv-clean",
      sourceMessageId: null,
      itemType: "summary",
      body: "Clean summary",
      now: now + 4,
    });
    insertLineageEdge(backend, {
      parentItemId: "ctx-clean-msg",
      childItemId: "sum-clean",
      relation: "summarizes",
      now: now + 5,
    });

    const checker = createLcmIntegrityChecker({ backend }) as SqliteLcmIntegrityChecker;
    const report = await checker.scan();

    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.invariants.every((invariant) => invariant.ok)).toBe(true);
    expect(report.repairPlan.actions).toHaveLength(0);
  });

  it("detects invariant 1, 2, and 4 violations", async () => {
    const backend = await createMigratedBackend("openclaw-lcm-integrity-broken-");
    const now = 1_900_000_010_000;

    insertConversation(backend, { conversationId: "conv-broken", now });
    insertContextItem(backend, {
      itemId: "sum-missing-source",
      conversationId: "conv-broken",
      sourceMessageId: null,
      itemType: "summary",
      body: "No source edges.",
      now: now + 1,
    });

    withForeignKeysDisabled(backend, () => {
      insertContextItem(backend, {
        itemId: "ctx-note-missing-source",
        conversationId: "conv-broken",
        sourceMessageId: "msg-missing-note",
        itemType: "note",
        body: "Dangling note source message reference.",
        now: now + 2,
      });
      insertContextItem(backend, {
        itemId: "ctx-message-missing-source",
        conversationId: "conv-broken",
        sourceMessageId: "msg-missing-canonical",
        itemType: "message",
        body: "Dangling message source reference.",
        now: now + 3,
      });
      insertMessagePart(backend, {
        partId: "part-orphan",
        messageId: "msg-does-not-exist",
        partIndex: 0,
        now: now + 4,
      });
    });

    const checker = createLcmIntegrityChecker({ backend }) as SqliteLcmIntegrityChecker;
    const report = await checker.scan();
    const codes = new Set(report.violations.map((violation) => violation.code));

    expect(codes.has("summary_without_source")).toBe(true);
    expect(codes.has("context_item_missing_source_message")).toBe(true);
    expect(codes.has("message_context_missing_canonical_message")).toBe(true);
    expect(codes.has("orphan_message_part")).toBe(true);
    expect(report.invariants.find((invariant) => invariant.id === 1)?.ok).toBe(false);
    expect(report.invariants.find((invariant) => invariant.id === 2)?.ok).toBe(false);
    expect(report.invariants.find((invariant) => invariant.id === 4)?.ok).toBe(false);
  });

  it("detects duplicate ordinals for messages and message parts", async () => {
    const backend = await createBackendWithDuplicateOrdinalRows();
    const checker = createLcmIntegrityChecker({ backend }) as SqliteLcmIntegrityChecker;

    const report = await checker.scan();
    const codes = new Set(report.violations.map((violation) => violation.code));

    expect(codes.has("duplicate_message_ordinal")).toBe(true);
    expect(codes.has("duplicate_message_part_ordinal")).toBe(true);
    expect(report.invariants.find((invariant) => invariant.id === 3)?.ok).toBe(false);
  });

  it("generates repair plans for fixable violations", async () => {
    const backend = await createMigratedBackend("openclaw-lcm-integrity-plan-");
    const now = 1_900_000_020_000;

    insertConversation(backend, { conversationId: "conv-plan", now });
    insertContextItem(backend, {
      itemId: "ctx-valid-child",
      conversationId: "conv-plan",
      sourceMessageId: null,
      itemType: "note",
      body: "Valid child item.",
      now: now + 1,
    });

    withForeignKeysDisabled(backend, () => {
      insertContextItem(backend, {
        itemId: "ctx-orphan-conversation",
        conversationId: "conv-missing",
        sourceMessageId: null,
        itemType: "note",
        body: "Orphan context item.",
        now: now + 2,
      });
      insertContextItem(backend, {
        itemId: "ctx-note-missing-source-plan",
        conversationId: "conv-plan",
        sourceMessageId: "msg-missing-plan",
        itemType: "note",
        body: "Missing source message reference.",
        now: now + 3,
      });
      insertLineageEdge(backend, {
        parentItemId: "ctx-missing-parent",
        childItemId: "ctx-valid-child",
        relation: "derived",
        now: now + 4,
      });
    });

    const checker = createLcmIntegrityChecker({ backend }) as SqliteLcmIntegrityChecker;
    const report = await checker.scan();
    const actionKinds = new Set(report.repairPlan.actions.map((action) => action.kind));

    expect(actionKinds.has("delete_context_item")).toBe(true);
    expect(actionKinds.has("clear_context_source_message")).toBe(true);
    expect(actionKinds.has("delete_lineage_edge")).toBe(true);
    expect(report.violations.some((violation) => violation.fixable)).toBe(true);
  });

  it("applies repair actions in repair mode and clears fixable issues", async () => {
    const backend = await createMigratedBackend("openclaw-lcm-integrity-repair-");
    const now = 1_900_000_030_000;

    insertConversation(backend, { conversationId: "conv-repair", now });
    insertContextItem(backend, {
      itemId: "ctx-child-repair",
      conversationId: "conv-repair",
      sourceMessageId: null,
      itemType: "note",
      body: "Valid child",
      now: now + 1,
    });

    withForeignKeysDisabled(backend, () => {
      insertContextItem(backend, {
        itemId: "ctx-note-missing-source-repair",
        conversationId: "conv-repair",
        sourceMessageId: "msg-missing-repair",
        itemType: "note",
        body: "Fixable source pointer.",
        now: now + 2,
      });
      insertLineageEdge(backend, {
        parentItemId: "ctx-missing-parent-repair",
        childItemId: "ctx-child-repair",
        relation: "derived",
        now: now + 3,
      });
    });

    const checker = createLcmIntegrityChecker({ backend }) as SqliteLcmIntegrityChecker;
    const repaired = await checker.scan({ mode: "repair" });

    expect(repaired.preRepairViolationCount).toBeGreaterThan(0);
    expect(repaired.repairResult?.attempted).toBe(repaired.repairPlan.actions.length);
    expect(repaired.repairResult?.applied).toBe(repaired.repairPlan.actions.length);
    expect(repaired.ok).toBe(true);

    const checkAgain = await checker.scan();
    expect(checkAgain.ok).toBe(true);
    expect(checkAgain.violations).toHaveLength(0);
  });
});

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

async function createBackendWithDuplicateOrdinalRows() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lcm-integrity-duplicates-"));
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

  const now = 1_900_000_040_000;
  db.prepare(
    `INSERT INTO lcm_conversations (conversation_id, session_id, channel, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("conv-duplicates", "session-duplicates", "test", now, now);
  db.prepare(
    `INSERT INTO lcm_messages (message_id, conversation_id, ordinal, role, author_id, content_text, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("msg-dup-a", "conv-duplicates", 1, "user", null, "first", "{}", now + 1);
  db.prepare(
    `INSERT INTO lcm_messages (message_id, conversation_id, ordinal, role, author_id, content_text, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("msg-dup-b", "conv-duplicates", 1, "assistant", null, "second", "{}", now + 2);
  db.prepare(
    `INSERT INTO lcm_message_parts (part_id, message_id, part_index, kind, mime_type, text_content, blob_path, token_count, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("part-dup-a", "msg-dup-a", 0, "text", null, "part A", null, null, "{}", now + 3);
  db.prepare(
    `INSERT INTO lcm_message_parts (part_id, message_id, part_index, kind, mime_type, text_content, blob_path, token_count, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("part-dup-b", "msg-dup-a", 0, "text", null, "part B", null, null, "{}", now + 4);
  db.close();

  const backend = createSqliteLcmStorageBackend({ dbPath });
  OPEN_BACKENDS.add(backend);
  return backend;
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

function insertConversation(
  backend: ReturnType<typeof createSqliteLcmStorageBackend>,
  params: {
    conversationId: string;
    now: number;
  },
): void {
  backend.execute(
    `INSERT INTO lcm_conversations (conversation_id, session_id, channel, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
    [params.conversationId, `${params.conversationId}-session`, "test", params.now, params.now],
  );
}

function insertMessage(
  backend: ReturnType<typeof createSqliteLcmStorageBackend>,
  params: {
    messageId: string;
    conversationId: string;
    ordinal: number;
    content: string;
    now: number;
  },
): void {
  backend.execute(
    `INSERT INTO lcm_messages (message_id, conversation_id, ordinal, role, author_id, content_text, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.messageId,
      params.conversationId,
      params.ordinal,
      "user",
      null,
      params.content,
      "{}",
      params.now,
    ],
  );
}

function insertMessagePart(
  backend: ReturnType<typeof createSqliteLcmStorageBackend>,
  params: {
    partId: string;
    messageId: string;
    partIndex: number;
    now: number;
  },
): void {
  backend.execute(
    `INSERT INTO lcm_message_parts (
      part_id, message_id, part_index, kind, mime_type, text_content, blob_path, token_count, payload_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.partId,
      params.messageId,
      params.partIndex,
      "text",
      null,
      "text",
      null,
      null,
      "{}",
      params.now,
    ],
  );
}

function insertContextItem(
  backend: ReturnType<typeof createSqliteLcmStorageBackend>,
  params: {
    itemId: string;
    conversationId: string;
    sourceMessageId: string | null;
    itemType: string;
    body: string;
    now: number;
  },
): void {
  backend.execute(
    `INSERT INTO lcm_context_items (
      item_id, conversation_id, source_message_id, item_type, depth, title, body,
      metadata_json, tombstoned, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.itemId,
      params.conversationId,
      params.sourceMessageId,
      params.itemType,
      0,
      null,
      params.body,
      "{}",
      0,
      params.now,
      params.now,
    ],
  );
}

function insertLineageEdge(
  backend: ReturnType<typeof createSqliteLcmStorageBackend>,
  params: {
    parentItemId: string;
    childItemId: string;
    relation: string;
    now: number;
  },
): void {
  backend.execute(
    `INSERT INTO lcm_lineage_edges (parent_item_id, child_item_id, relation, metadata_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
    [params.parentItemId, params.childItemId, params.relation, "{}", params.now],
  );
}
