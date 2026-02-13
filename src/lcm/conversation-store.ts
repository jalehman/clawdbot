import { createHash } from "node:crypto";
import type { LcmStorageBackend, LcmStorageConnection } from "./storage/types.js";
import type {
  AppendContextMessageInput,
  ConversationId,
  ConversationStore,
  CreateMessageInput,
  CreateMessagePartsInput,
  GetContextItemsInput,
  InsertSummaryInput,
  LcmContextItem,
  LcmContextItemType,
  LcmMessageSearchHit,
  LcmSummaryItem,
  LcmSummarySearchHit,
  LinkSummaryToMessagesInput,
  LinkSummaryToParentsInput,
  ListMessagesInput,
  MessageId,
  ReplaceContextRangeWithSummaryInput,
  SearchMessagesInput,
  SearchSummariesInput,
  StoredLcmMessage,
  StoredLcmMessagePart,
  SummaryId,
} from "./types.js";

type ConversationStoreOptions = {
  storage: LcmStorageBackend;
};

type DbMessageRow = {
  message_id: string;
  conversation_id: string;
  ordinal: number;
  role: string;
  author_id: string | null;
  content_text: string;
  payload_json: string;
  created_at_ms: number;
};

type DbContextItemRow = {
  item_id: string;
  conversation_id: string;
  source_message_id: string | null;
  item_type: string;
  depth: number;
  title: string | null;
  body: string;
  metadata_json: string;
  tombstoned: number;
  created_at_ms: number;
  updated_at_ms: number;
};

type DbSummarySearchRow = {
  item_id: string;
  conversation_id: string;
  title: string | null;
  body: string;
  created_at_ms: number;
  score?: number;
};

/**
 * SQLite-backed conversation store for canonical ingestion, lineage, and retrieval.
 */
export class SqliteConversationStore implements ConversationStore {
  private readonly storage: LcmStorageBackend;

  /**
   * Build a store around the migrated LCM storage backend.
   */
  constructor(options: ConversationStoreOptions) {
    this.storage = options.storage;
  }

  /**
   * Insert one canonical message record if it does not exist already.
   */
  async createMessage(input: CreateMessageInput): Promise<StoredLcmMessage> {
    return this.storage.withTransaction(
      (tx) => {
        ensureConversation(tx, {
          conversationId: input.conversationId,
          sessionId: input.sessionId,
          channel: input.channel,
          nowMs: input.createdAtMs,
        });

        tx.execute(
          `INSERT OR IGNORE INTO lcm_messages (
            message_id, conversation_id, ordinal, role, author_id, content_text, payload_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.messageId,
            input.conversationId,
            input.ordinal,
            input.role,
            input.authorId ?? null,
            input.contentText,
            stringifyRecord(input.payload),
            input.createdAtMs,
          ],
        );

        const row =
          tx.get<DbMessageRow>(
            `SELECT message_id, conversation_id, ordinal, role, author_id, content_text, payload_json, created_at_ms
             FROM lcm_messages
             WHERE message_id = ?`,
            [input.messageId],
          ) ??
          tx.get<DbMessageRow>(
            `SELECT message_id, conversation_id, ordinal, role, author_id, content_text, payload_json, created_at_ms
             FROM lcm_messages
             WHERE conversation_id = ? AND ordinal = ?`,
            [input.conversationId, input.ordinal],
          );

        if (!row) {
          throw new Error("LCM message insert failed and no existing row was found.");
        }

        tx.execute("UPDATE lcm_conversations SET updated_at_ms = ? WHERE conversation_id = ?", [
          input.createdAtMs,
          input.conversationId,
        ]);

        return mapMessageRow(row);
      },
      { mode: "immediate" },
    );
  }

  /**
   * Insert canonical parts for a message idempotently.
   */
  async createMessageParts(input: CreateMessagePartsInput): Promise<void> {
    const sorted = input.parts.toSorted((a, b) => a.partIndex - b.partIndex);
    await this.storage.withTransaction(
      (tx) => {
        for (const part of sorted) {
          insertMessagePart(tx, input.messageId, part);
        }
      },
      { mode: "immediate" },
    );
  }

  /**
   * Insert one summary context item.
   */
  async insertSummary(input: InsertSummaryInput): Promise<LcmSummaryItem> {
    return this.storage.withTransaction(
      (tx) => {
        tx.execute(
          `INSERT OR IGNORE INTO lcm_context_items (
            item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, 'summary', ?, ?, ?, ?, 0, ?, ?)`,
          [
            input.summaryId,
            input.conversationId,
            input.sourceMessageId ?? null,
            input.depth ?? 0,
            input.title ?? null,
            input.body,
            stringifyRecord(input.metadata ?? {}),
            input.createdAtMs,
            input.createdAtMs,
          ],
        );

        const row = tx.get<DbContextItemRow>(
          `SELECT item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
           FROM lcm_context_items
           WHERE item_id = ? AND item_type = 'summary'`,
          [input.summaryId],
        );
        if (!row) {
          throw new Error("LCM summary insert failed and no existing row was found.");
        }
        return mapSummaryRow(row);
      },
      { mode: "immediate" },
    );
  }

  /**
   * Link a summary to direct message parents through context-item lineage edges.
   */
  async linkSummaryToMessages(input: LinkSummaryToMessagesInput): Promise<void> {
    await this.storage.withTransaction(
      (tx) => {
        const relation = input.relation?.trim() || "summarizes";
        const uniqueMessageIds = Array.from(new Set(input.messageIds));
        for (const messageId of uniqueMessageIds) {
          const contextItemId = ensureMessageContextItem(tx, {
            conversationId: input.conversationId,
            messageId,
            createdAtMs: input.createdAtMs,
          });
          if (!contextItemId) {
            continue;
          }
          insertLineageEdge(tx, {
            parentItemId: contextItemId,
            childItemId: input.summaryId,
            relation,
            metadata: input.metadata ?? {},
            createdAtMs: input.createdAtMs,
          });
        }
      },
      { mode: "immediate" },
    );
  }

  /**
   * Link a summary to parent summaries, preserving append-first lineage history.
   */
  async linkSummaryToParents(input: LinkSummaryToParentsInput): Promise<void> {
    await this.storage.withTransaction(
      (tx) => {
        const relation = input.relation?.trim() || "derived";
        const parentIds = Array.from(new Set(input.parentSummaryIds));
        for (const parentSummaryId of parentIds) {
          insertLineageEdge(tx, {
            parentItemId: parentSummaryId,
            childItemId: input.summaryId,
            relation,
            metadata: input.metadata ?? {},
            createdAtMs: input.createdAtMs,
          });
        }
      },
      { mode: "immediate" },
    );
  }

  /**
   * Tombstone a range of active context items and point them to a replacement summary.
   */
  async replaceContextRangeWithSummary(
    input: ReplaceContextRangeWithSummaryInput,
  ): Promise<number> {
    return this.storage.withTransaction(
      (tx) => {
        const bounds = tx.all<{ item_id: string; created_at_ms: number }>(
          `SELECT item_id, created_at_ms
           FROM lcm_context_items
           WHERE conversation_id = ? AND item_id IN (?, ?)`,
          [input.conversationId, input.startItemId, input.endItemId],
        );

        const startMs = bounds.find((row) => row.item_id === input.startItemId)?.created_at_ms;
        const endMs = bounds.find((row) => row.item_id === input.endItemId)?.created_at_ms;
        if (startMs === undefined || endMs === undefined) {
          return 0;
        }
        const minMs = Math.min(startMs, endMs);
        const maxMs = Math.max(startMs, endMs);

        const rows = tx.all<{ item_id: string }>(
          `SELECT item_id
           FROM lcm_context_items
           WHERE conversation_id = ?
             AND tombstoned = 0
             AND created_at_ms BETWEEN ? AND ?
             AND item_id <> ?
           ORDER BY created_at_ms ASC, item_id ASC`,
          [input.conversationId, minMs, maxMs, input.summaryId],
        );

        for (const row of rows) {
          tx.execute(
            "UPDATE lcm_context_items SET tombstoned = 1, updated_at_ms = ? WHERE item_id = ?",
            [input.updatedAtMs, row.item_id],
          );
          insertLineageEdge(tx, {
            parentItemId: row.item_id,
            childItemId: input.summaryId,
            relation: "compacted",
            metadata: input.metadata ?? {},
            createdAtMs: input.updatedAtMs,
          });
        }

        return rows.length;
      },
      { mode: "immediate" },
    );
  }

  /**
   * Append a message-backed context item if missing.
   */
  async appendContextMessage(input: AppendContextMessageInput): Promise<LcmContextItem> {
    return this.storage.withTransaction(
      (tx) => {
        tx.execute(
          `INSERT OR IGNORE INTO lcm_context_items (
            item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, 'message', ?, ?, ?, ?, 0, ?, ?)`,
          [
            input.itemId,
            input.conversationId,
            input.messageId,
            input.depth ?? 0,
            input.title ?? null,
            input.body,
            stringifyRecord(input.metadata ?? {}),
            input.createdAtMs,
            input.createdAtMs,
          ],
        );

        const row =
          tx.get<DbContextItemRow>(
            `SELECT item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
             FROM lcm_context_items
             WHERE item_id = ?`,
            [input.itemId],
          ) ??
          tx.get<DbContextItemRow>(
            `SELECT item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
             FROM lcm_context_items
             WHERE conversation_id = ? AND source_message_id = ? AND item_type = 'message'`,
            [input.conversationId, input.messageId],
          );

        if (!row) {
          throw new Error("LCM context message insert failed and no existing row was found.");
        }
        return mapContextItemRow(row);
      },
      { mode: "immediate" },
    );
  }

  /**
   * Return context items in deterministic order.
   */
  async getContextItems(input: GetContextItemsInput): Promise<LcmContextItem[]> {
    const where: string[] = ["conversation_id = ?"];
    const params: Array<string | number> = [input.conversationId];
    if (!input.includeTombstoned) {
      where.push("tombstoned = 0");
    }
    const itemTypes = (input.itemTypes ?? []).filter(Boolean);
    if (itemTypes.length > 0) {
      where.push(`item_type IN (${itemTypes.map(() => "?").join(", ")})`);
      params.push(...itemTypes);
    }
    const limit = Math.max(1, Math.trunc(input.limit ?? 500));
    params.push(limit);
    const rows = this.storage.all<DbContextItemRow>(
      `SELECT item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
       FROM lcm_context_items
       WHERE ${where.join(" AND ")}
       ORDER BY created_at_ms ASC, item_id ASC
       LIMIT ?`,
      params,
    );
    return rows.map(mapContextItemRow);
  }

  /**
   * Fetch one summary item by identifier.
   */
  async getSummary(summaryId: SummaryId): Promise<LcmSummaryItem | null> {
    const row = this.storage.get<DbContextItemRow>(
      `SELECT item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
       FROM lcm_context_items
       WHERE item_id = ? AND item_type = 'summary'`,
      [summaryId],
    );
    return row ? mapSummaryRow(row) : null;
  }

  /**
   * Return direct child summaries for one summary item.
   */
  async getSummaryChildren(summaryId: SummaryId): Promise<LcmSummaryItem[]> {
    const rows = this.storage.all<DbContextItemRow>(
      `SELECT c.item_id, c.conversation_id, c.source_message_id, c.item_type, c.depth, c.title, c.body, c.metadata_json, c.tombstoned, c.created_at_ms, c.updated_at_ms
       FROM lcm_lineage_edges e
       INNER JOIN lcm_context_items c ON c.item_id = e.child_item_id
       WHERE e.parent_item_id = ?
         AND c.item_type = 'summary'
         AND c.tombstoned = 0
       ORDER BY c.created_at_ms ASC, c.item_id ASC`,
      [summaryId],
    );
    return rows.map(mapSummaryRow);
  }

  /**
   * Resolve source messages for a summary using recursive parent traversal.
   */
  async getSummaryMessages(summaryId: SummaryId, limit = 500): Promise<StoredLcmMessage[]> {
    const summary = this.storage.get<{ conversation_id: string }>(
      "SELECT conversation_id FROM lcm_context_items WHERE item_id = ? AND item_type = 'summary'",
      [summaryId],
    );
    if (!summary) {
      return [];
    }
    const boundedLimit = Math.max(1, Math.trunc(limit));
    const rows = this.storage.all<DbMessageRow>(
      `WITH RECURSIVE parents(item_id) AS (
         SELECT parent_item_id
         FROM lcm_lineage_edges
         WHERE child_item_id = ?
         UNION
         SELECT e.parent_item_id
         FROM lcm_lineage_edges e
         INNER JOIN parents p ON p.item_id = e.child_item_id
       )
       SELECT DISTINCT m.message_id, m.conversation_id, m.ordinal, m.role, m.author_id, m.content_text, m.payload_json, m.created_at_ms
       FROM parents p
       INNER JOIN lcm_context_items ci ON ci.item_id = p.item_id
       INNER JOIN lcm_messages m ON m.message_id = ci.source_message_id
       WHERE ci.item_type = 'message'
         AND m.conversation_id = ?
       ORDER BY m.ordinal ASC
       LIMIT ?`,
      [summaryId, summary.conversation_id, boundedLimit],
    );
    return rows.map(mapMessageRow);
  }

  /**
   * List canonical messages for a conversation in ordinal order.
   */
  async listMessages(input: ListMessagesInput): Promise<StoredLcmMessage[]> {
    const where: string[] = ["conversation_id = ?"];
    const params: Array<string | number> = [input.conversationId];

    const messageIds = (input.messageIds ?? []).filter(Boolean);
    if (messageIds.length > 0) {
      where.push(`message_id IN (${messageIds.map(() => "?").join(", ")})`);
      params.push(...messageIds);
    }

    const limit = Math.max(1, Math.trunc(input.limit ?? 2_000));
    params.push(limit);
    const direction = input.descending ? "DESC" : "ASC";
    const rows = this.storage.all<DbMessageRow>(
      `SELECT message_id, conversation_id, ordinal, role, author_id, content_text, payload_json, created_at_ms
       FROM lcm_messages
       WHERE ${where.join(" AND ")}
       ORDER BY ordinal ${direction}
       LIMIT ?`,
      params,
    );
    return rows.map(mapMessageRow);
  }

  /**
   * Run a callback in a single SQLite transaction scope.
   */
  async withTransaction<T>(fn: (store: ConversationStore) => Promise<T> | T): Promise<T> {
    return this.storage.withTransaction(() => fn(this), { mode: "immediate" });
  }

  /**
   * Search canonical message text.
   */
  async searchMessages(input: SearchMessagesInput): Promise<LcmMessageSearchHit[]> {
    const query = input.query.trim();
    if (!query) {
      return [];
    }
    const like = `%${query}%`;
    const limit = Math.max(1, Math.trunc(input.limit ?? 20));
    const rows = this.storage.all<DbMessageRow>(
      `SELECT message_id, conversation_id, ordinal, role, author_id, content_text, payload_json, created_at_ms
       FROM lcm_messages
       WHERE conversation_id = ?
         AND (
           content_text LIKE ? COLLATE NOCASE
           OR payload_json LIKE ? COLLATE NOCASE
         )
       ORDER BY ordinal ASC
       LIMIT ?`,
      [input.conversationId, like, like, limit],
    );
    return rows.map((row) => ({
      messageId: toMessageId(row.message_id),
      conversationId: toConversationId(row.conversation_id),
      ordinal: row.ordinal,
      role: toMessageRole(row.role),
      snippet: buildSnippet(row.content_text, query),
      createdAtMs: row.created_at_ms,
    }));
  }

  /**
   * Search summary context items, preferring FTS when available.
   */
  async searchSummaries(input: SearchSummariesInput): Promise<LcmSummarySearchHit[]> {
    const query = input.query.trim();
    if (!query) {
      return [];
    }
    const limit = Math.max(1, Math.trunc(input.limit ?? 20));
    if (this.storage.ftsAvailable) {
      try {
        const rows = this.storage.all<DbSummarySearchRow>(
          `SELECT ci.item_id, ci.conversation_id, ci.title, ci.body, ci.created_at_ms, bm25(lcm_context_items_fts) AS score
           FROM lcm_context_items_fts
           INNER JOIN lcm_context_items ci ON ci.rowid = lcm_context_items_fts.rowid
           WHERE lcm_context_items_fts MATCH ?
             AND ci.conversation_id = ?
             AND ci.item_type = 'summary'
             AND ci.tombstoned = 0
           ORDER BY score ASC, ci.created_at_ms ASC
           LIMIT ?`,
          [escapeFtsQuery(query), input.conversationId, limit],
        );
        return rows.map((row) => ({
          summaryId: toSummaryId(row.item_id),
          conversationId: toConversationId(row.conversation_id),
          title: row.title ?? undefined,
          snippet: buildSnippet(row.body, query),
          score: row.score,
          createdAtMs: row.created_at_ms,
        }));
      } catch {
        // Some user input cannot be parsed by FTS5; fall back to LIKE search.
      }
    }

    const like = `%${query}%`;
    const rows = this.storage.all<DbSummarySearchRow>(
      `SELECT item_id, conversation_id, title, body, created_at_ms
       FROM lcm_context_items
       WHERE conversation_id = ?
         AND item_type = 'summary'
         AND tombstoned = 0
         AND (title LIKE ? COLLATE NOCASE OR body LIKE ? COLLATE NOCASE)
       ORDER BY created_at_ms ASC
       LIMIT ?`,
      [input.conversationId, like, like, limit],
    );
    return rows.map((row) => ({
      summaryId: toSummaryId(row.item_id),
      conversationId: toConversationId(row.conversation_id),
      title: row.title ?? undefined,
      snippet: buildSnippet(row.body, query),
      createdAtMs: row.created_at_ms,
    }));
  }
}

/**
 * Build a deterministic context-item id scoped by a conversation id.
 */
export function buildConversationScopedItemId(
  prefix: string,
  conversationId: ConversationId,
  suffix: string,
): string {
  return `${prefix}_${digestHex(`${conversationId}:${suffix}`).slice(0, 24)}`;
}

/**
 * Factory for the default sqlite conversation store implementation.
 */
export function createConversationStore(options: ConversationStoreOptions): ConversationStore {
  return new SqliteConversationStore(options);
}

function ensureConversation(
  tx: LcmStorageConnection,
  params: { conversationId: ConversationId; sessionId: string; channel?: string; nowMs: number },
): void {
  tx.execute(
    `INSERT OR IGNORE INTO lcm_conversations (
      conversation_id, session_id, channel, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?)`,
    [params.conversationId, params.sessionId, params.channel ?? null, params.nowMs, params.nowMs],
  );
  tx.execute("UPDATE lcm_conversations SET updated_at_ms = ? WHERE conversation_id = ?", [
    params.nowMs,
    params.conversationId,
  ]);
}

function insertMessagePart(
  tx: LcmStorageConnection,
  messageId: MessageId,
  part: StoredLcmMessagePart,
): void {
  tx.execute(
    `INSERT OR IGNORE INTO lcm_message_parts (
      part_id, message_id, part_index, kind, mime_type, text_content, blob_path, token_count, payload_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      part.partId,
      messageId,
      part.partIndex,
      part.kind,
      part.mimeType ?? null,
      part.textContent ?? null,
      part.blobPath ?? null,
      part.tokenCount ?? null,
      stringifyRecord(part.payload),
      part.createdAtMs,
    ],
  );
}

function ensureMessageContextItem(
  tx: LcmStorageConnection,
  params: { conversationId: ConversationId; messageId: MessageId; createdAtMs: number },
): string | null {
  const existing = tx.get<{ item_id: string }>(
    `SELECT item_id
     FROM lcm_context_items
     WHERE conversation_id = ?
       AND source_message_id = ?
       AND item_type = 'message'
     ORDER BY created_at_ms ASC
     LIMIT 1`,
    [params.conversationId, params.messageId],
  );
  if (existing?.item_id) {
    return existing.item_id;
  }

  const message = tx.get<{ content_text: string }>(
    "SELECT content_text FROM lcm_messages WHERE conversation_id = ? AND message_id = ?",
    [params.conversationId, params.messageId],
  );
  if (!message) {
    return null;
  }

  const itemId = buildConversationScopedItemId("ctxmsg", params.conversationId, params.messageId);
  tx.execute(
    `INSERT OR IGNORE INTO lcm_context_items (
      item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 'message', 0, NULL, ?, '{}', 0, ?, ?)`,
    [
      itemId,
      params.conversationId,
      params.messageId,
      message.content_text,
      params.createdAtMs,
      params.createdAtMs,
    ],
  );
  return itemId;
}

function insertLineageEdge(
  tx: LcmStorageConnection,
  params: {
    parentItemId: string;
    childItemId: string;
    relation: string;
    metadata: Record<string, unknown>;
    createdAtMs: number;
  },
): void {
  tx.execute(
    `INSERT OR IGNORE INTO lcm_lineage_edges (
      parent_item_id, child_item_id, relation, metadata_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?)`,
    [
      params.parentItemId,
      params.childItemId,
      params.relation,
      stringifyRecord(params.metadata),
      params.createdAtMs,
    ],
  );
}

function mapMessageRow(row: DbMessageRow): StoredLcmMessage {
  return {
    messageId: toMessageId(row.message_id),
    conversationId: toConversationId(row.conversation_id),
    ordinal: row.ordinal,
    role: toMessageRole(row.role),
    authorId: row.author_id ?? undefined,
    contentText: row.content_text,
    payload: parseRecord(row.payload_json),
    createdAtMs: row.created_at_ms,
  };
}

function mapContextItemRow(row: DbContextItemRow): LcmContextItem {
  return {
    itemId: row.item_id,
    conversationId: toConversationId(row.conversation_id),
    sourceMessageId: row.source_message_id ? toMessageId(row.source_message_id) : undefined,
    itemType: toContextItemType(row.item_type),
    depth: row.depth,
    title: row.title ?? undefined,
    body: row.body,
    metadata: parseRecord(row.metadata_json),
    tombstoned: row.tombstoned === 1,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function mapSummaryRow(row: DbContextItemRow): LcmSummaryItem {
  return {
    ...mapContextItemRow(row),
    itemType: "summary",
  };
}

function toMessageRole(value: string): StoredLcmMessage["role"] {
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") {
    return value;
  }
  return "assistant";
}

function toContextItemType(value: string): LcmContextItemType {
  if (value === "message" || value === "summary" || value === "note" || value === "artifact") {
    return value;
  }
  return "note";
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Keep malformed payloads from failing read paths.
  }
  return {};
}

function stringifyRecord(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function buildSnippet(text: string, query: string, width = 160): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const lowerText = trimmed.toLowerCase();
  const lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) {
    return trimmed.slice(0, width);
  }
  const index = lowerText.indexOf(lowerQuery);
  if (index < 0) {
    return trimmed.slice(0, width);
  }
  const start = Math.max(0, index - Math.floor(width / 3));
  const end = Math.min(trimmed.length, start + width);
  return trimmed.slice(start, end);
}

function escapeFtsQuery(query: string): string {
  const escaped = query.replaceAll('"', '""');
  return `"${escaped}"`;
}

function digestHex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function toConversationId(value: string): ConversationId {
  return value as ConversationId;
}

function toMessageId(value: string): MessageId {
  return value as MessageId;
}

function toSummaryId(value: string): SummaryId {
  return value as SummaryId;
}
