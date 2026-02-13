import type { DatabaseSync } from "node:sqlite";

export type SummaryKind = "leaf" | "condensed";
export type ContextItemType = "message" | "summary";

export type CreateSummaryInput = {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  content: string;
  tokenCount: number;
  fileIds?: string[];
};

export type SummaryRecord = {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  content: string;
  tokenCount: number;
  fileIds: string[];
  createdAt: Date;
};

export type ContextItemRecord = {
  conversationId: number;
  ordinal: number;
  itemType: ContextItemType;
  messageId: number | null;
  summaryId: string | null;
  createdAt: Date;
};

export type SummarySearchInput = {
  conversationId?: number;
  query: string;
  mode: "regex" | "full_text";
  limit?: number;
};

export type SummarySearchResult = {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  snippet: string;
  rank?: number;
};

export type CreateLargeFileInput = {
  fileId: string;
  conversationId: number;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  storageUri: string;
  explorationSummary?: string;
};

export type LargeFileRecord = {
  fileId: string;
  conversationId: number;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  storageUri: string;
  explorationSummary: string | null;
  createdAt: Date;
};

// ── DB row shapes (snake_case) ────────────────────────────────────────────────

interface SummaryRow {
  summary_id: string;
  conversation_id: number;
  kind: SummaryKind;
  content: string;
  token_count: number;
  file_ids: string;
  created_at: string;
}

interface ContextItemRow {
  conversation_id: number;
  ordinal: number;
  item_type: ContextItemType;
  message_id: number | null;
  summary_id: string | null;
  created_at: string;
}

interface SummarySearchRow {
  summary_id: string;
  conversation_id: number;
  kind: SummaryKind;
  snippet: string;
  rank: number;
}

interface MaxOrdinalRow {
  max_ordinal: number;
}

interface TokenSumRow {
  total: number;
}

interface MessageIdRow {
  message_id: number;
}

interface LargeFileRow {
  file_id: string;
  conversation_id: number;
  file_name: string | null;
  mime_type: string | null;
  byte_size: number | null;
  storage_uri: string;
  exploration_summary: string | null;
  created_at: string;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function toSummaryRecord(row: SummaryRow): SummaryRecord {
  let fileIds: string[] = [];
  try {
    fileIds = JSON.parse(row.file_ids);
  } catch {
    // ignore malformed JSON
  }
  return {
    summaryId: row.summary_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    content: row.content,
    tokenCount: row.token_count,
    fileIds,
    createdAt: new Date(row.created_at),
  };
}

function toContextItemRecord(row: ContextItemRow): ContextItemRecord {
  return {
    conversationId: row.conversation_id,
    ordinal: row.ordinal,
    itemType: row.item_type,
    messageId: row.message_id,
    summaryId: row.summary_id,
    createdAt: new Date(row.created_at),
  };
}

function toSearchResult(row: SummarySearchRow): SummarySearchResult {
  return {
    summaryId: row.summary_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    snippet: row.snippet,
    rank: row.rank,
  };
}

function toLargeFileRecord(row: LargeFileRow): LargeFileRecord {
  return {
    fileId: row.file_id,
    conversationId: row.conversation_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    storageUri: row.storage_uri,
    explorationSummary: row.exploration_summary,
    createdAt: new Date(row.created_at),
  };
}

// ── SummaryStore ──────────────────────────────────────────────────────────────

export class SummaryStore {
  constructor(private db: DatabaseSync) {}

  // ── Summary CRUD ──────────────────────────────────────────────────────────

  async insertSummary(input: CreateSummaryInput): Promise<SummaryRecord> {
    const fileIds = JSON.stringify(input.fileIds ?? []);

    this.db
      .prepare(
        `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.summaryId,
        input.conversationId,
        input.kind,
        input.content,
        input.tokenCount,
        fileIds,
      );

    // Index in FTS5 (store summary_id as unindexed column)
    this.db
      .prepare(`INSERT INTO summaries_fts(summary_id, content) VALUES (?, ?)`)
      .run(input.summaryId, input.content);

    const row = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, content, token_count, file_ids, created_at
       FROM summaries WHERE summary_id = ?`,
      )
      .get(input.summaryId) as unknown as SummaryRow;

    return toSummaryRecord(row);
  }

  async getSummary(summaryId: string): Promise<SummaryRecord | null> {
    const row = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, content, token_count, file_ids, created_at
       FROM summaries WHERE summary_id = ?`,
      )
      .get(summaryId) as unknown as SummaryRow | undefined;
    return row ? toSummaryRecord(row) : null;
  }

  async getSummariesByConversation(conversationId: number): Promise<SummaryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, content, token_count, file_ids, created_at
       FROM summaries
       WHERE conversation_id = ?
       ORDER BY created_at`,
      )
      .all(conversationId) as unknown as SummaryRow[];
    return rows.map(toSummaryRecord);
  }

  // ── Lineage ───────────────────────────────────────────────────────────────

  async linkSummaryToMessages(summaryId: string, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const stmt = this.db.prepare(
      `INSERT INTO summary_messages (summary_id, message_id, ordinal)
       VALUES (?, ?, ?)
       ON CONFLICT (summary_id, message_id) DO NOTHING`,
    );

    for (let idx = 0; idx < messageIds.length; idx++) {
      stmt.run(summaryId, messageIds[idx], idx);
    }
  }

  async linkSummaryToParents(summaryId: string, parentSummaryIds: string[]): Promise<void> {
    if (parentSummaryIds.length === 0) {
      return;
    }

    const stmt = this.db.prepare(
      `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
       VALUES (?, ?, ?)
       ON CONFLICT (summary_id, parent_summary_id) DO NOTHING`,
    );

    for (let idx = 0; idx < parentSummaryIds.length; idx++) {
      stmt.run(summaryId, parentSummaryIds[idx], idx);
    }
  }

  async getSummaryMessages(summaryId: string): Promise<number[]> {
    const rows = this.db
      .prepare(
        `SELECT message_id FROM summary_messages
       WHERE summary_id = ?
       ORDER BY ordinal`,
      )
      .all(summaryId) as unknown as MessageIdRow[];
    return rows.map((r) => r.message_id);
  }

  async getSummaryChildren(parentSummaryId: string): Promise<SummaryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT s.summary_id, s.conversation_id, s.kind, s.content, s.token_count, s.file_ids, s.created_at
       FROM summaries s
       JOIN summary_parents sp ON sp.summary_id = s.summary_id
       WHERE sp.parent_summary_id = ?
       ORDER BY sp.ordinal`,
      )
      .all(parentSummaryId) as unknown as SummaryRow[];
    return rows.map(toSummaryRecord);
  }

  async getSummaryParents(summaryId: string): Promise<SummaryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT s.summary_id, s.conversation_id, s.kind, s.content, s.token_count, s.file_ids, s.created_at
       FROM summaries s
       JOIN summary_parents sp ON sp.parent_summary_id = s.summary_id
       WHERE sp.summary_id = ?
       ORDER BY sp.ordinal`,
      )
      .all(summaryId) as unknown as SummaryRow[];
    return rows.map(toSummaryRecord);
  }

  // ── Context items ─────────────────────────────────────────────────────────

  async getContextItems(conversationId: number): Promise<ContextItemRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT conversation_id, ordinal, item_type, message_id, summary_id, created_at
       FROM context_items
       WHERE conversation_id = ?
       ORDER BY ordinal`,
      )
      .all(conversationId) as unknown as ContextItemRow[];
    return rows.map(toContextItemRecord);
  }

  async appendContextMessage(conversationId: number, messageId: number): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
       FROM context_items WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as MaxOrdinalRow;

    this.db
      .prepare(
        `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
       VALUES (?, ?, 'message', ?)`,
      )
      .run(conversationId, row.max_ordinal + 1, messageId);
  }

  async appendContextMessages(conversationId: number, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
       FROM context_items WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as MaxOrdinalRow;
    const baseOrdinal = row.max_ordinal + 1;

    const stmt = this.db.prepare(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
       VALUES (?, ?, 'message', ?)`,
    );
    for (let idx = 0; idx < messageIds.length; idx++) {
      stmt.run(conversationId, baseOrdinal + idx, messageIds[idx]);
    }
  }

  async appendContextSummary(conversationId: number, summaryId: string): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
       FROM context_items WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as MaxOrdinalRow;

    this.db
      .prepare(
        `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
       VALUES (?, ?, 'summary', ?)`,
      )
      .run(conversationId, row.max_ordinal + 1, summaryId);
  }

  async replaceContextRangeWithSummary(input: {
    conversationId: number;
    startOrdinal: number;
    endOrdinal: number;
    summaryId: string;
  }): Promise<void> {
    const { conversationId, startOrdinal, endOrdinal, summaryId } = input;

    this.db.exec("BEGIN");
    try {
      // 1. Delete context items in the range [startOrdinal, endOrdinal]
      this.db
        .prepare(
          `DELETE FROM context_items
         WHERE conversation_id = ?
           AND ordinal >= ?
           AND ordinal <= ?`,
        )
        .run(conversationId, startOrdinal, endOrdinal);

      // 2. Insert the replacement summary item at startOrdinal
      this.db
        .prepare(
          `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
         VALUES (?, ?, 'summary', ?)`,
        )
        .run(conversationId, startOrdinal, summaryId);

      // 3. Resequence all ordinals to maintain contiguity (no gaps).
      //    Fetch current items, then update ordinals in order.
      const items = this.db
        .prepare(
          `SELECT ordinal FROM context_items
         WHERE conversation_id = ?
         ORDER BY ordinal`,
        )
        .all(conversationId) as unknown as { ordinal: number }[];

      const updateStmt = this.db.prepare(
        `UPDATE context_items
         SET ordinal = ?
         WHERE conversation_id = ? AND ordinal = ?`,
      );

      // Use negative temp ordinals first to avoid unique constraint conflicts
      for (let i = 0; i < items.length; i++) {
        updateStmt.run(-(i + 1), conversationId, items[i].ordinal);
      }
      for (let i = 0; i < items.length; i++) {
        updateStmt.run(i, conversationId, -(i + 1));
      }

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async getContextTokenCount(conversationId: number): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(token_count), 0) AS total
       FROM (
         SELECT m.token_count
         FROM context_items ci
         JOIN messages m ON m.message_id = ci.message_id
         WHERE ci.conversation_id = ?
           AND ci.item_type = 'message'

         UNION ALL

         SELECT s.token_count
         FROM context_items ci
         JOIN summaries s ON s.summary_id = ci.summary_id
         WHERE ci.conversation_id = ?
           AND ci.item_type = 'summary'
       ) sub`,
      )
      .get(conversationId, conversationId) as unknown as TokenSumRow;
    return row?.total ?? 0;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchSummaries(input: SummarySearchInput): Promise<SummarySearchResult[]> {
    const limit = input.limit ?? 50;

    if (input.mode === "full_text") {
      return this.searchFullText(input.query, limit, input.conversationId);
    }
    return this.searchRegex(input.query, limit, input.conversationId);
  }

  private searchFullText(
    query: string,
    limit: number,
    conversationId?: number,
  ): SummarySearchResult[] {
    if (conversationId != null) {
      const rows = this.db
        .prepare(
          `SELECT
           sf.summary_id,
           s.conversation_id,
           s.kind,
           snippet(summaries_fts, 1, '', '', '...', 32) AS snippet,
           summaries_fts.rank
         FROM summaries_fts sf
         JOIN summaries s ON s.summary_id = sf.summary_id
         WHERE summaries_fts MATCH ?
           AND s.conversation_id = ?
         ORDER BY summaries_fts.rank
         LIMIT ?`,
        )
        .all(query, conversationId, limit) as unknown as SummarySearchRow[];
      return rows.map(toSearchResult);
    }

    const rows = this.db
      .prepare(
        `SELECT
         sf.summary_id,
         s.conversation_id,
         s.kind,
         snippet(summaries_fts, 1, '', '', '...', 32) AS snippet,
         summaries_fts.rank
       FROM summaries_fts sf
       JOIN summaries s ON s.summary_id = sf.summary_id
       WHERE summaries_fts MATCH ?
       ORDER BY summaries_fts.rank
       LIMIT ?`,
      )
      .all(query, limit) as unknown as SummarySearchRow[];
    return rows.map(toSearchResult);
  }

  private searchRegex(
    pattern: string,
    limit: number,
    conversationId?: number,
  ): SummarySearchResult[] {
    const re = new RegExp(pattern);

    let rows: SummaryRow[];
    if (conversationId != null) {
      rows = this.db
        .prepare(
          `SELECT summary_id, conversation_id, kind, content, token_count, file_ids, created_at
         FROM summaries
         WHERE conversation_id = ?
         ORDER BY created_at`,
        )
        .all(conversationId) as unknown as SummaryRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT summary_id, conversation_id, kind, content, token_count, file_ids, created_at
         FROM summaries
         ORDER BY summary_id`,
        )
        .all() as unknown as SummaryRow[];
    }

    const results: SummarySearchResult[] = [];
    for (const row of rows) {
      if (results.length >= limit) {
        break;
      }
      const match = re.exec(row.content);
      if (match) {
        results.push({
          summaryId: row.summary_id,
          conversationId: row.conversation_id,
          kind: row.kind,
          snippet: match[0],
          rank: 0,
        });
      }
    }
    return results;
  }

  // ── Large files ───────────────────────────────────────────────────────────

  async insertLargeFile(input: CreateLargeFileInput): Promise<LargeFileRecord> {
    this.db
      .prepare(
        `INSERT INTO large_files (file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.fileId,
        input.conversationId,
        input.fileName ?? null,
        input.mimeType ?? null,
        input.byteSize ?? null,
        input.storageUri,
        input.explorationSummary ?? null,
      );

    const row = this.db
      .prepare(
        `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
       FROM large_files WHERE file_id = ?`,
      )
      .get(input.fileId) as unknown as LargeFileRow;

    return toLargeFileRecord(row);
  }

  async getLargeFile(fileId: string): Promise<LargeFileRecord | null> {
    const row = this.db
      .prepare(
        `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
       FROM large_files WHERE file_id = ?`,
      )
      .get(fileId) as unknown as LargeFileRow | undefined;
    return row ? toLargeFileRecord(row) : null;
  }

  async getLargeFilesByConversation(conversationId: number): Promise<LargeFileRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
       FROM large_files
       WHERE conversation_id = ?
       ORDER BY created_at`,
      )
      .all(conversationId) as unknown as LargeFileRow[];
    return rows.map(toLargeFileRecord);
  }
}
