# LCM Internal Service Specification

## Purpose

This document specifies an internal Lossless Context Management (LCM) subsystem. It is transport-agnostic and intended to run as in-process services plus background workers.

"Lossless" means traceable, recoverable context through explicit lineage from summaries back to canonical source records.

## Scope

- Internal service contracts and data model
- Compaction and retrieval behavior
- Storage invariants and integrity checks
- Background worker responsibilities

Out of scope:

- Public HTTP surface (can be added as adapter)
- Provider-specific prompt templates
- Semantic vector retrieval (v1 uses full-text and regex)

## Architecture

### Modules

1. `ConversationStore`

- Persists canonical messages and parts.
- Persists summaries, lineage, active context items.

2. `TokenEstimator`

- Estimates token usage for messages, summaries, and assembled context.

3. `ContextAssembler`

- Selects ordered context items for model input under a token budget.

4. `CompactionEngine`

- Creates leaf and condensed summaries.
- Rewrites active context references.

5. `RetrievalEngine`

- Describes LCM IDs.
- Searches historical records.
- Expands summaries to descendants and source content.

6. `IntegrityChecker`

- Verifies lineage and referential integrity.
- Produces reports and repair plans.

7. `LargeFileService`

- Stores large artifacts and associates file IDs to summaries/messages.

### Runtime Topology

- Foreground path: ingest -> store -> assemble -> model call
- Background path: compaction jobs, integrity jobs, maintenance jobs
- Optional adapter layer: CLI, MCP tool bindings, HTTP API

## Core Types

```ts
type ConversationId = number;
type MessageId = number;
type SummaryId = string; // e.g. sum_xxx

type MessageRole = "system" | "user" | "assistant" | "tool";
type SummaryKind = "leaf" | "condensed";
type ContextItemType = "message" | "summary";

type MessagePartType =
  | "text"
  | "reasoning"
  | "tool"
  | "patch"
  | "file"
  | "subtask"
  | "compaction"
  | "step_start"
  | "step_finish"
  | "snapshot"
  | "agent"
  | "retry";
```

## Internal Service Interfaces

### 1) ConversationStore

```ts
interface ConversationStore {
  createMessage(input: CreateMessageInput): Promise<MessageRecord>;
  createMessageParts(input: CreateMessagePartInput[]): Promise<void>;

  insertSummary(input: CreateSummaryInput): Promise<SummaryRecord>;
  linkSummaryToMessages(input: LinkSummaryMessagesInput[]): Promise<void>;
  linkSummaryToParents(input: LinkSummaryParentsInput[]): Promise<void>;

  replaceContextRangeWithSummary(input: ReplaceContextRangeInput): Promise<void>;
  appendContextMessage(input: AppendContextMessageInput): Promise<void>;

  getContextItems(conversationId: ConversationId): Promise<ContextItemRecord[]>;
  getSummary(summaryId: SummaryId): Promise<SummaryRecord | null>;
  getSummaryChildren(summaryId: SummaryId): Promise<SummaryRecord[]>;
  getSummaryMessages(summaryId: SummaryId): Promise<MessageRecord[]>;

  searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]>;
  searchSummaries(input: SummarySearchInput): Promise<SummarySearchResult[]>;
}
```

### 2) ContextAssembler

```ts
interface ContextAssembler {
  assemble(input: AssembleContextInput): Promise<AssembleContextResult>;
}
```

Behavior:

- Always include system/policy content.
- Include freshest raw turns first (then restore chronological order in output).
- Add summaries for older context by relevance and recency.
- Stop at token budget.
- Return deterministic order and token estimate.

### 3) CompactionEngine

```ts
interface CompactionEngine {
  evaluate(input: EvaluateCompactionInput): Promise<CompactionDecision>;
  compact(input: CompactInput): Promise<CompactionResult>;
}
```

Behavior:

- Uses conversation-scoped lock.
- Transactional writes for each compaction batch.
- Emits compaction event part in `message_parts`.

### 4) RetrievalEngine

```ts
interface RetrievalEngine {
  describe(id: string): Promise<DescribeResult | null>;
  grep(input: GrepInput): Promise<GrepResult>;
  expand(input: ExpandInput): Promise<ExpandResult>;
}
```

Behavior:

- `describe` handles summary IDs and file IDs.
- `grep` supports regex and full-text over messages/summaries.
- `expand` supports depth-limited traversal with token cap.

### Sub-Agent Expansion Strategy

Expansion should use a two-tier flow:

- Main agent performs routing: discover target IDs via `describe` and `grep`.
- Sub-agent performs deep traversal: call `expand` recursively on selected summaries.
- Main agent receives distilled findings, not full raw expansion payloads.

Policy rules:

- Prefer direct expansion only for shallow reads.
- Use sub-agent expansion for multi-hop traversal, broad time ranges, or high token risk.
- `expand` is for summary IDs; file IDs should be resolved with `describe` and file readers.

Execution contract:

1. Main agent identifies candidate summary IDs.
2. Main agent spawns sub-agent with narrow question and token cap.
3. Sub-agent runs `expand` at bounded depth and returns concise synthesis + cited IDs.
4. Main agent decides whether to request another focused expansion pass.

### 5) IntegrityChecker

```ts
interface IntegrityChecker {
  run(conversationId?: ConversationId): Promise<IntegrityReport>;
  planRepairs(report: IntegrityReport): Promise<RepairPlan>;
}
```

## Worker Contracts

### Compaction Worker

Input job:

```ts
interface CompactionJob {
  conversationId: ConversationId;
  reason: "threshold" | "manual" | "maintenance";
  requestedAt: string;
}
```

Execution steps:

1. Acquire conversation advisory lock.
2. Recompute context pressure.
3. Perform leaf pass.
4. Optionally perform condensed pass.
5. Commit transaction(s).
6. Emit metrics and structured logs.

### Integrity Worker

Input job:

```ts
interface IntegrityJob {
  conversationId?: ConversationId;
  mode: "scan" | "scan_and_plan";
}
```

Execution steps:

1. Validate lineage constraints.
2. Validate context pointer validity.
3. Report orphaned/invalid references.
4. Optionally create repair plan (no automatic destructive repair in v1).

## Compaction Algorithm

### Trigger Conditions

Compaction should run when one or more conditions are true:

- `assembled_tokens >= context_threshold * model_token_budget`
- `active_message_count > max_active_messages`
- explicit manual request

### Leaf Pass

1. Select oldest eligible raw message window from active context.
2. Generate summary content targeting `leaf_target_tokens`.
3. Write summary row with `kind='leaf'`.
4. Link source messages in `summary_messages`.
5. Replace corresponding `context_items` with one summary item.
6. Write a `message_parts` entry with `part_type='compaction'`.

### Condensed Pass

1. Select adjacent stale leaf summaries.
2. Generate condensed summary targeting `condensed_target_tokens`.
3. Write summary row with `kind='condensed'`.
4. Link children in `summary_parents`.
5. Replace grouped summary context items with new condensed summary item.

### Safety Rules

- Never delete canonical `messages` or `message_parts` in compaction.
- Never compact newest `fresh_tail_count` raw turns.
- Preserve ordering invariants in `context_items`.
- Keep operations idempotent where practical (safe retry semantics).

## Retrieval Semantics

### describe(id)

Returns:

- item kind (`summary` or `file`)
- created time, token count
- parent/child lineage
- source message range if available

### grep

Inputs:

- query string
- mode: `regex | full_text`
- scope: `messages | summaries | both`
- limit

Output:

- ordered matches with snippets and source IDs

### expand

Inputs:

- `summaryId`
- traversal depth
- include raw messages flag
- token cap

Output:

- child summaries and/or source messages
- estimated tokens
- truncation indicator

Operational guidance:

- Favor iterative expansion passes over one large expansion.
- Keep each sub-agent expansion bounded by explicit depth and token cap.
- Return IDs for follow-up expansion to preserve auditability and control context growth.

## Storage Schema (PostgreSQL)

```sql
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
```

## Transactions and Locking

- Use one advisory lock per conversation during compaction.
- Use transaction boundary per compaction batch.
- Ensure no partial lineage writes.
- Return retryable conflict on lock contention.

## Configuration

- `LCM_ENABLED` (bool)
- `LCM_CONTEXT_THRESHOLD` (float, default `0.75`)
- `LCM_FRESH_TAIL_COUNT` (int, default `8`)
- `LCM_LEAF_TARGET_TOKENS` (int, default `600`)
- `LCM_CONDENSED_TARGET_TOKENS` (int, default `900`)
- `LCM_MAX_EXPAND_TOKENS` (int, default `4000`)
- `LCM_AUTOCOMPACT_DISABLED` (bool)
- `LCM_DATABASE_URL` (string)

## Observability

### Metrics

- `lcm_context_tokens_total`
- `lcm_compaction_runs_total`
- `lcm_summaries_created_total{kind}`
- `lcm_expand_latency_ms`
- `lcm_search_latency_ms`
- `lcm_integrity_failures_total`

### Structured Log Fields

- `conversation_id`
- `session_id`
- `compaction_id`
- `summary_id`
- `trigger_reason`
- `token_before`
- `token_after`

## Invariants

1. Every summary links to at least one source (`summary_messages` or `summary_parents`).
2. Every `context_items` reference points to existing row.
3. No duplicate ordinals per (`conversation_id`, `ordinal`) and (`message_id`, `ordinal`).
4. Canonical raw message/part rows are never deleted by compaction.

## Acceptance Criteria

1. Compaction reduces assembled context tokens by >= 30% on fixture conversations.
2. Any summary can be expanded back to canonical source messages.
3. Search works across both raw and summarized history.
4. Integrity checker reports zero broken lineage in steady state.
5. Compaction is safe under concurrent write load (no partial graph states).

## Optional Adapter Layer

Adapters may expose these service methods via:

- CLI commands
- MCP tools
- HTTP/gRPC endpoints

Adapters must not own compaction logic or lineage rules; those stay in core services.
