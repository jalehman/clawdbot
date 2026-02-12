import type { LcmSchemaMigration } from "./types.js";

/**
 * Schema migrations for LCM SQLite storage.
 *
 * Notes:
 * - Timestamps are stored as epoch milliseconds.
 * - JSON payloads are stored as TEXT for portability.
 * - Lineage edges are append-first and constrained by foreign keys.
 */
export const LCM_SCHEMA_MIGRATIONS: ReadonlyArray<LcmSchemaMigration> = [
  {
    version: 1,
    name: "initial-lcm-schema",
    statements: [
      `CREATE TABLE IF NOT EXISTS lcm_conversations (
        conversation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_lcm_conversations_session_id
        ON lcm_conversations(session_id)`,

      `CREATE TABLE IF NOT EXISTS lcm_messages (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES lcm_conversations(conversation_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        author_id TEXT,
        content_text TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at_ms INTEGER NOT NULL,
        UNIQUE(conversation_id, ordinal)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_lcm_messages_conversation_created
        ON lcm_messages(conversation_id, created_at_ms)`,

      `CREATE TABLE IF NOT EXISTS lcm_message_parts (
        part_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES lcm_messages(message_id) ON DELETE CASCADE,
        part_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        mime_type TEXT,
        text_content TEXT,
        blob_path TEXT,
        token_count INTEGER,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at_ms INTEGER NOT NULL,
        UNIQUE(message_id, part_index)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_lcm_message_parts_message_id
        ON lcm_message_parts(message_id)`,

      `CREATE TABLE IF NOT EXISTS lcm_context_items (
        item_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES lcm_conversations(conversation_id) ON DELETE CASCADE,
        source_message_id TEXT REFERENCES lcm_messages(message_id) ON DELETE SET NULL,
        item_type TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        title TEXT,
        body TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        tombstoned INTEGER NOT NULL DEFAULT 0 CHECK (tombstoned IN (0, 1)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_lcm_context_items_conversation_created
        ON lcm_context_items(conversation_id, created_at_ms)`,
      `CREATE INDEX IF NOT EXISTS idx_lcm_context_items_source_message
        ON lcm_context_items(source_message_id)`,
      `CREATE INDEX IF NOT EXISTS idx_lcm_context_items_type
        ON lcm_context_items(item_type)`,

      `CREATE TABLE IF NOT EXISTS lcm_lineage_edges (
        parent_item_id TEXT NOT NULL REFERENCES lcm_context_items(item_id) ON DELETE CASCADE,
        child_item_id TEXT NOT NULL REFERENCES lcm_context_items(item_id) ON DELETE CASCADE,
        relation TEXT NOT NULL DEFAULT 'derived',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY(parent_item_id, child_item_id, relation),
        CHECK(parent_item_id <> child_item_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_lcm_lineage_edges_child
        ON lcm_lineage_edges(child_item_id)`,

      `CREATE TABLE IF NOT EXISTS lcm_compaction_runs (
        run_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES lcm_conversations(conversation_id) ON DELETE CASCADE,
        strategy TEXT NOT NULL,
        status TEXT NOT NULL,
        summary_item_id TEXT REFERENCES lcm_context_items(item_id) ON DELETE SET NULL,
        input_item_count INTEGER NOT NULL DEFAULT 0,
        output_item_count INTEGER NOT NULL DEFAULT 0,
        error_text TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        started_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_lcm_compaction_runs_conversation_started
        ON lcm_compaction_runs(conversation_id, started_at_ms)`,

      `CREATE TABLE IF NOT EXISTS lcm_artifacts (
        artifact_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES lcm_conversations(conversation_id) ON DELETE CASCADE,
        message_id TEXT REFERENCES lcm_messages(message_id) ON DELETE SET NULL,
        part_id TEXT REFERENCES lcm_message_parts(part_id) ON DELETE SET NULL,
        path TEXT NOT NULL,
        mime_type TEXT,
        bytes INTEGER,
        sha256 TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at_ms INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_lcm_artifacts_conversation_created
        ON lcm_artifacts(conversation_id, created_at_ms)`,
      `CREATE INDEX IF NOT EXISTS idx_lcm_artifacts_sha256
        ON lcm_artifacts(sha256)`,
    ],
  },
];

/**
 * SQLite FTS5 objects for context-item text retrieval.
 */
export const LCM_FTS_STATEMENTS: ReadonlyArray<string> = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS lcm_context_items_fts USING fts5(
    item_id UNINDEXED,
    conversation_id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61'
  )`,
  `CREATE TRIGGER IF NOT EXISTS lcm_context_items_ai
    AFTER INSERT ON lcm_context_items
    WHEN NEW.tombstoned = 0
    BEGIN
      INSERT INTO lcm_context_items_fts (rowid, item_id, conversation_id, title, body)
      VALUES (NEW.rowid, NEW.item_id, NEW.conversation_id, COALESCE(NEW.title, ''), NEW.body);
    END`,
  `CREATE TRIGGER IF NOT EXISTS lcm_context_items_ad
    AFTER DELETE ON lcm_context_items
    BEGIN
      DELETE FROM lcm_context_items_fts WHERE rowid = OLD.rowid;
    END`,
  `CREATE TRIGGER IF NOT EXISTS lcm_context_items_au
    AFTER UPDATE ON lcm_context_items
    BEGIN
      DELETE FROM lcm_context_items_fts WHERE rowid = OLD.rowid;
      INSERT INTO lcm_context_items_fts (rowid, item_id, conversation_id, title, body)
      SELECT NEW.rowid, NEW.item_id, NEW.conversation_id, COALESCE(NEW.title, ''), NEW.body
      WHERE NEW.tombstoned = 0;
    END`,
];
