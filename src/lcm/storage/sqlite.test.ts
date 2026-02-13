import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LCM_SCHEMA_MIGRATIONS } from "./schema.js";
import { SqliteLcmStorageBackend } from "./sqlite.js";

const OPEN_HANDLES = new Set<SqliteLcmStorageBackend>();
const OPEN_DIRS = new Set<string>();

afterEach(async () => {
  for (const backend of OPEN_HANDLES) {
    await backend.close();
  }
  OPEN_HANDLES.clear();
  for (const dir of OPEN_DIRS) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  OPEN_DIRS.clear();
});

describe("SqliteLcmStorageBackend", () => {
  it("applies migrations and enables WAL defaults", async () => {
    const backend = await createBackend();
    await backend.migrate();

    const tables = backend.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );
    const tableNames = new Set(tables.map((row) => row.name));
    expect(tableNames.has("lcm_conversations")).toBe(true);
    expect(tableNames.has("lcm_messages")).toBe(true);
    expect(tableNames.has("lcm_message_parts")).toBe(true);
    expect(tableNames.has("lcm_context_items")).toBe(true);
    expect(tableNames.has("lcm_lineage_edges")).toBe(true);
    expect(tableNames.has("lcm_compaction_runs")).toBe(true);
    expect(tableNames.has("lcm_artifacts")).toBe(true);
    expect(tableNames.has("lcm_schema_migrations")).toBe(true);

    const journal = backend.get<{ journal_mode: string }>("PRAGMA journal_mode");
    expect((journal?.journal_mode ?? "").toLowerCase()).toBe("wal");
    const foreignKeys = backend.get<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(foreignKeys?.foreign_keys).toBe(1);
  });

  it("keeps migrations idempotent", async () => {
    const backend = await createBackend();
    await backend.migrate();
    await backend.migrate();

    const row = backend.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM lcm_schema_migrations",
    );
    expect(row?.count).toBe(LCM_SCHEMA_MIGRATIONS.length);
  });

  it("rolls back lineage writes when a transaction fails", async () => {
    const backend = await createBackend();
    await backend.migrate();

    await expect(
      backend.withTransaction((tx) => {
        const now = Date.now();
        tx.execute(
          `INSERT INTO lcm_conversations (conversation_id, session_id, channel, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
          ["conv-1", "session-1", "discord", now, now],
        );
        tx.execute(
          `INSERT INTO lcm_context_items (
            item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ["item-parent", "conv-1", null, "message", 0, "Parent", "parent body", "{}", 0, now, now],
        );
        tx.execute(
          `INSERT INTO lcm_context_items (
            item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ["item-child", "conv-1", null, "summary", 1, "Child", "child body", "{}", 0, now, now],
        );
        tx.execute(
          `INSERT INTO lcm_lineage_edges (parent_item_id, child_item_id, relation, metadata_json, created_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
          ["item-parent", "item-child", "derived", "{}", now],
        );
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const conversations = backend.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM lcm_conversations",
    );
    const items = backend.get<{ count: number }>("SELECT COUNT(*) AS count FROM lcm_context_items");
    const edges = backend.get<{ count: number }>("SELECT COUNT(*) AS count FROM lcm_lineage_edges");
    expect(conversations?.count).toBe(0);
    expect(items?.count).toBe(0);
    expect(edges?.count).toBe(0);
  });

  it("retries SQLITE_BUSY conflicts for write transactions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lcm-storage-"));
    OPEN_DIRS.add(dir);
    const dbPath = path.join(dir, "lcm.sqlite");
    const locker = new SqliteLcmStorageBackend({
      dbPath,
      busyTimeoutMs: 10,
      busyRetryDelayMs: 10,
      maxBusyRetries: 1,
    });
    const writer = new SqliteLcmStorageBackend({
      dbPath,
      busyTimeoutMs: 10,
      busyRetryDelayMs: 25,
      maxBusyRetries: 4,
    });
    OPEN_HANDLES.add(locker);
    OPEN_HANDLES.add(writer);

    await locker.migrate();
    locker.execute("BEGIN IMMEDIATE");

    const releaseLock = new Promise<void>((resolve) => {
      setTimeout(() => {
        locker.execute("COMMIT");
        resolve();
      }, 40);
    });

    await Promise.all([
      releaseLock,
      writer.withTransaction((tx) => {
        const now = Date.now();
        tx.execute(
          `INSERT INTO lcm_conversations (conversation_id, session_id, channel, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
          ["retry-conv", "retry-session", "telegram", now, now],
        );
      }),
    ]);

    const inserted = writer.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM lcm_conversations WHERE conversation_id = ?",
      ["retry-conv"],
    );
    expect(inserted?.count).toBe(1);
  });

  it("indexes context items with FTS5 when available", async () => {
    const backend = await createBackend();
    await backend.migrate();

    if (!backend.ftsAvailable) {
      expect(backend.ftsEnabled).toBe(true);
      return;
    }

    const now = Date.now();
    backend.execute(
      `INSERT INTO lcm_conversations (conversation_id, session_id, channel, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      ["fts-conv", "fts-session", "web", now, now],
    );
    backend.execute(
      `INSERT INTO lcm_context_items (
         item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "fts-item",
        "fts-conv",
        null,
        "summary",
        0,
        "Kernel Notes",
        "SQLite supports lightweight full text search",
        "{}",
        0,
        now,
        now,
      ],
    );

    const initialMatch = backend.all<{ item_id: string }>(
      "SELECT item_id FROM lcm_context_items_fts WHERE lcm_context_items_fts MATCH ?",
      ["lightweight"],
    );
    expect(initialMatch).toEqual([{ item_id: "fts-item" }]);

    backend.execute("UPDATE lcm_context_items SET body = ?, updated_at_ms = ? WHERE item_id = ?", [
      "lineage integrity checks remain searchable",
      now + 1,
      "fts-item",
    ]);

    const oldTerm = backend.all<{ item_id: string }>(
      "SELECT item_id FROM lcm_context_items_fts WHERE lcm_context_items_fts MATCH ?",
      ["lightweight"],
    );
    const newTerm = backend.all<{ item_id: string }>(
      "SELECT item_id FROM lcm_context_items_fts WHERE lcm_context_items_fts MATCH ?",
      ["integrity"],
    );
    expect(oldTerm).toHaveLength(0);
    expect(newTerm).toEqual([{ item_id: "fts-item" }]);
  });
});

async function createBackend(): Promise<SqliteLcmStorageBackend> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lcm-storage-"));
  OPEN_DIRS.add(dir);
  const backend = new SqliteLcmStorageBackend({
    dbPath: path.join(dir, "lcm.sqlite"),
  });
  OPEN_HANDLES.add(backend);
  return backend;
}
