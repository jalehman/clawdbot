CREATE TYPE message_role AS ENUM ('system', 'user', 'assistant', 'tool');
CREATE TYPE summary_kind AS ENUM ('leaf', 'condensed');
CREATE TYPE context_item_type AS ENUM ('message', 'summary');
CREATE TYPE message_part_type AS ENUM (
  'text', 'reasoning', 'tool', 'patch', 'file',
  'subtask', 'compaction', 'step_start', 'step_finish',
  'snapshot', 'agent', 'retry'
);

CREATE TABLE conversations (
  conversation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  message_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  role message_role NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX messages_conv_seq_idx ON messages (conversation_id, seq);
CREATE INDEX messages_tsv_gin_idx ON messages USING gin (content_tsv);

CREATE TABLE summaries (
  summary_id TEXT PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  kind summary_kind NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  file_ids JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX summaries_conv_created_idx ON summaries (conversation_id, created_at);
CREATE INDEX summaries_tsv_gin_idx ON summaries USING gin (content_tsv);

CREATE TABLE message_parts (
  part_id TEXT PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  part_type message_part_type NOT NULL,
  ordinal INTEGER NOT NULL,
  text_content TEXT,
  is_ignored BOOLEAN,
  is_synthetic BOOLEAN,
  tool_call_id TEXT,
  tool_name TEXT,
  tool_status TEXT,
  tool_input JSONB,
  tool_output TEXT,
  tool_error TEXT,
  tool_title TEXT,
  patch_hash TEXT,
  patch_files TEXT[],
  file_mime TEXT,
  file_name TEXT,
  file_url TEXT,
  subtask_prompt TEXT,
  subtask_desc TEXT,
  subtask_agent TEXT,
  step_reason TEXT,
  step_cost NUMERIC,
  step_tokens_in INTEGER,
  step_tokens_out INTEGER,
  snapshot_hash TEXT,
  compaction_auto BOOLEAN,
  metadata JSONB,
  UNIQUE (message_id, ordinal)
);
CREATE INDEX message_parts_message_idx ON message_parts (message_id);
CREATE INDEX message_parts_type_idx ON message_parts (part_type);

CREATE TABLE summary_messages (
  summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
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
  conversation_id BIGINT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  ordinal BIGINT NOT NULL,
  item_type context_item_type NOT NULL,
  message_id BIGINT REFERENCES messages(message_id) ON DELETE RESTRICT,
  summary_id TEXT REFERENCES summaries(summary_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, ordinal),
  CHECK (
    (item_type = 'message' AND message_id IS NOT NULL AND summary_id IS NULL) OR
    (item_type = 'summary' AND summary_id IS NOT NULL AND message_id IS NULL)
  )
);
CREATE INDEX context_items_conv_idx ON context_items (conversation_id, ordinal);

CREATE TABLE large_files (
  file_id TEXT PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  file_name TEXT,
  mime_type TEXT,
  byte_size BIGINT,
  storage_uri TEXT NOT NULL,
  exploration_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX large_files_conv_idx ON large_files (conversation_id, created_at);
