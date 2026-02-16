-- SQLite schema for LCM (Lossless Context Management)
-- This file is for reference only; migrations are run inline from migration.ts.

CREATE TABLE conversations (
  conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'unknown',
  session_key TEXT,
  title TEXT,
  bootstrapped_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX conversations_agent_created_idx ON conversations (agent_id, created_at DESC);
CREATE INDEX conversations_session_key_created_idx ON conversations (session_key, created_at DESC);

CREATE TABLE messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (conversation_id, seq)
);
CREATE INDEX messages_conv_seq_idx ON messages (conversation_id, seq);

CREATE TABLE summaries (
  summary_id TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('leaf', 'condensed')),
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  file_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX summaries_conv_created_idx ON summaries (conversation_id, created_at);

CREATE TABLE message_parts (
  part_id TEXT PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  part_type TEXT NOT NULL CHECK (part_type IN (
    'text', 'reasoning', 'tool', 'patch', 'file',
    'subtask', 'compaction', 'step_start', 'step_finish',
    'snapshot', 'agent', 'retry'
  )),
  ordinal INTEGER NOT NULL,
  text_content TEXT,
  is_ignored INTEGER,
  is_synthetic INTEGER,
  tool_call_id TEXT,
  tool_name TEXT,
  tool_status TEXT,
  tool_input TEXT,
  tool_output TEXT,
  tool_error TEXT,
  tool_title TEXT,
  patch_hash TEXT,
  patch_files TEXT,
  file_mime TEXT,
  file_name TEXT,
  file_url TEXT,
  subtask_prompt TEXT,
  subtask_desc TEXT,
  subtask_agent TEXT,
  step_reason TEXT,
  step_cost REAL,
  step_tokens_in INTEGER,
  step_tokens_out INTEGER,
  snapshot_hash TEXT,
  compaction_auto INTEGER,
  metadata TEXT,
  UNIQUE (message_id, ordinal)
);
CREATE INDEX message_parts_message_idx ON message_parts (message_id);
CREATE INDEX message_parts_type_idx ON message_parts (part_type);

CREATE TABLE summary_messages (
  summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (summary_id, message_id)
);

CREATE TABLE summary_parents (
  summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
  parent_summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (summary_id, parent_summary_id)
);

CREATE TABLE context_items (
  conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('message', 'summary')),
  message_id INTEGER REFERENCES messages(message_id) ON DELETE RESTRICT,
  summary_id TEXT REFERENCES summaries(summary_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, ordinal),
  CHECK (
    (item_type = 'message' AND message_id IS NOT NULL AND summary_id IS NULL) OR
    (item_type = 'summary' AND summary_id IS NOT NULL AND message_id IS NULL)
  )
);
CREATE INDEX context_items_conv_idx ON context_items (conversation_id, ordinal);

CREATE TABLE large_files (
  file_id TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  file_name TEXT,
  mime_type TEXT,
  byte_size INTEGER,
  storage_uri TEXT NOT NULL,
  exploration_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX large_files_conv_idx ON large_files (conversation_id, created_at);

-- FTS5 virtual tables for full-text search
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE summaries_fts USING fts5(
  summary_id UNINDEXED,
  content,
  tokenize='porter unicode61'
);
