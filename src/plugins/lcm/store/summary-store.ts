import type postgres from "postgres";

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

/** Escape null bytes (0x00) which PostgreSQL text columns reject. */
const escNull = (s: string) => s.replaceAll("\0", "\\x00");

// ── DB row shapes (snake_case) ────────────────────────────────────────────────

interface SummaryRow {
  summary_id: string;
  conversation_id: number;
  kind: SummaryKind;
  content: string;
  token_count: number;
  file_ids: string[];
  created_at: Date;
}

interface ContextItemRow {
  conversation_id: number;
  ordinal: number;
  item_type: ContextItemType;
  message_id: number | null;
  summary_id: string | null;
  created_at: Date;
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
  created_at: Date;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function toSummaryRecord(row: SummaryRow): SummaryRecord {
  return {
    summaryId: row.summary_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    content: row.content,
    tokenCount: row.token_count,
    fileIds: row.file_ids ?? [],
    createdAt: row.created_at,
  };
}

function toContextItemRecord(row: ContextItemRow): ContextItemRecord {
  return {
    conversationId: row.conversation_id,
    ordinal: row.ordinal,
    itemType: row.item_type,
    messageId: row.message_id,
    summaryId: row.summary_id,
    createdAt: row.created_at,
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
    createdAt: row.created_at,
  };
}

// ── SummaryStore ──────────────────────────────────────────────────────────────

export class SummaryStore {
  constructor(private sql: ReturnType<typeof postgres>) {}

  // ── Summary CRUD ──────────────────────────────────────────────────────────

  async insertSummary(input: CreateSummaryInput): Promise<SummaryRecord> {
    const fileIds = JSON.stringify(input.fileIds ?? []);
    const [row] = await this.sql<SummaryRow[]>`
      INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids)
      VALUES (
        ${input.summaryId},
        ${input.conversationId},
        ${input.kind}::summary_kind,
        ${escNull(input.content)},
        ${input.tokenCount},
        ${fileIds}::jsonb
      )
      RETURNING summary_id, conversation_id, kind, content, token_count, file_ids, created_at
    `;
    return toSummaryRecord(row);
  }

  async getSummary(summaryId: string): Promise<SummaryRecord | null> {
    const rows = await this.sql<SummaryRow[]>`
      SELECT summary_id, conversation_id, kind, content, token_count, file_ids, created_at
      FROM summaries
      WHERE summary_id = ${summaryId}
    `;
    return rows[0] ? toSummaryRecord(rows[0]) : null;
  }

  async getSummariesByConversation(conversationId: number): Promise<SummaryRecord[]> {
    const rows = await this.sql<SummaryRow[]>`
      SELECT summary_id, conversation_id, kind, content, token_count, file_ids, created_at
      FROM summaries
      WHERE conversation_id = ${conversationId}
      ORDER BY created_at
    `;
    return rows.map(toSummaryRecord);
  }

  // ── Lineage ───────────────────────────────────────────────────────────────

  async linkSummaryToMessages(summaryId: string, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) return;

    const values = messageIds.map((msgId, idx) => ({
      summary_id: summaryId,
      message_id: msgId,
      ordinal: idx,
    }));

    await this.sql`
      INSERT INTO summary_messages ${this.sql(values, "summary_id", "message_id", "ordinal")}
      ON CONFLICT (summary_id, message_id) DO NOTHING
    `;
  }

  async linkSummaryToParents(summaryId: string, parentSummaryIds: string[]): Promise<void> {
    if (parentSummaryIds.length === 0) return;

    const values = parentSummaryIds.map((parentId, idx) => ({
      summary_id: summaryId,
      parent_summary_id: parentId,
      ordinal: idx,
    }));

    await this.sql`
      INSERT INTO summary_parents ${this.sql(values, "summary_id", "parent_summary_id", "ordinal")}
      ON CONFLICT (summary_id, parent_summary_id) DO NOTHING
    `;
  }

  async getSummaryMessages(summaryId: string): Promise<number[]> {
    const rows = await this.sql<MessageIdRow[]>`
      SELECT message_id
      FROM summary_messages
      WHERE summary_id = ${summaryId}
      ORDER BY ordinal
    `;
    return rows.map((r) => r.message_id);
  }

  async getSummaryChildren(parentSummaryId: string): Promise<SummaryRecord[]> {
    const rows = await this.sql<SummaryRow[]>`
      SELECT s.summary_id, s.conversation_id, s.kind, s.content, s.token_count, s.file_ids, s.created_at
      FROM summaries s
      JOIN summary_parents sp ON sp.summary_id = s.summary_id
      WHERE sp.parent_summary_id = ${parentSummaryId}
      ORDER BY sp.ordinal
    `;
    return rows.map(toSummaryRecord);
  }

  async getSummaryParents(summaryId: string): Promise<SummaryRecord[]> {
    const rows = await this.sql<SummaryRow[]>`
      SELECT s.summary_id, s.conversation_id, s.kind, s.content, s.token_count, s.file_ids, s.created_at
      FROM summaries s
      JOIN summary_parents sp ON sp.parent_summary_id = s.summary_id
      WHERE sp.summary_id = ${summaryId}
      ORDER BY sp.ordinal
    `;
    return rows.map(toSummaryRecord);
  }

  // ── Context items ─────────────────────────────────────────────────────────

  async getContextItems(conversationId: number): Promise<ContextItemRecord[]> {
    const rows = await this.sql<ContextItemRow[]>`
      SELECT conversation_id, ordinal, item_type, message_id, summary_id, created_at
      FROM context_items
      WHERE conversation_id = ${conversationId}
      ORDER BY ordinal
    `;
    return rows.map(toContextItemRecord);
  }

  async appendContextMessage(conversationId: number, messageId: number): Promise<void> {
    const [{ max_ordinal }] = await this.sql<MaxOrdinalRow[]>`
      SELECT COALESCE(MAX(ordinal), -1)::bigint AS max_ordinal
      FROM context_items
      WHERE conversation_id = ${conversationId}
    `;

    await this.sql`
      INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
      VALUES (${conversationId}, ${max_ordinal + 1}, 'message'::context_item_type, ${messageId})
    `;
  }

  async appendContextSummary(conversationId: number, summaryId: string): Promise<void> {
    const [{ max_ordinal }] = await this.sql<MaxOrdinalRow[]>`
      SELECT COALESCE(MAX(ordinal), -1)::bigint AS max_ordinal
      FROM context_items
      WHERE conversation_id = ${conversationId}
    `;

    await this.sql`
      INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
      VALUES (${conversationId}, ${max_ordinal + 1}, 'summary'::context_item_type, ${summaryId})
    `;
  }

  async replaceContextRangeWithSummary(input: {
    conversationId: number;
    startOrdinal: number;
    endOrdinal: number;
    summaryId: string;
  }): Promise<void> {
    const { conversationId, startOrdinal, endOrdinal, summaryId } = input;

    await this.sql.begin(async (tx) => {
      // 1. Delete context items in the range [startOrdinal, endOrdinal]
      await tx`
        DELETE FROM context_items
        WHERE conversation_id = ${conversationId}
          AND ordinal >= ${startOrdinal}
          AND ordinal <= ${endOrdinal}
      `;

      // 2. Insert the replacement summary item at startOrdinal
      await tx`
        INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
        VALUES (${conversationId}, ${startOrdinal}, 'summary'::context_item_type, ${summaryId})
      `;

      // 3. Resequence all ordinals to maintain contiguity (no gaps).
      //    We use a CTE to compute new dense ordinals based on row order.
      await tx`
        WITH numbered AS (
          SELECT
            conversation_id,
            ordinal AS old_ordinal,
            (ROW_NUMBER() OVER (ORDER BY ordinal) - 1)::bigint AS new_ordinal
          FROM context_items
          WHERE conversation_id = ${conversationId}
        )
        UPDATE context_items ci
        SET ordinal = n.new_ordinal
        FROM numbered n
        WHERE ci.conversation_id = n.conversation_id
          AND ci.ordinal = n.old_ordinal
          AND ci.conversation_id = ${conversationId}
      `;
    });
  }

  async getContextTokenCount(conversationId: number): Promise<number> {
    const rows = await this.sql<TokenSumRow[]>`
      SELECT COALESCE(SUM(token_count), 0)::int AS total
      FROM (
        SELECT m.token_count
        FROM context_items ci
        JOIN messages m ON m.message_id = ci.message_id
        WHERE ci.conversation_id = ${conversationId}
          AND ci.item_type = 'message'

        UNION ALL

        SELECT s.token_count
        FROM context_items ci
        JOIN summaries s ON s.summary_id = ci.summary_id
        WHERE ci.conversation_id = ${conversationId}
          AND ci.item_type = 'summary'
      ) sub
    `;
    return rows[0]?.total ?? 0;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchSummaries(input: SummarySearchInput): Promise<SummarySearchResult[]> {
    const limit = input.limit ?? 50;

    if (input.mode === "full_text") {
      return this.searchFullText(input.query, limit, input.conversationId);
    }
    return this.searchRegex(input.query, limit, input.conversationId);
  }

  private async searchFullText(
    query: string,
    limit: number,
    conversationId?: number,
  ): Promise<SummarySearchResult[]> {
    if (conversationId != null) {
      const rows = await this.sql<SummarySearchRow[]>`
        SELECT
          summary_id,
          conversation_id,
          kind,
          ts_headline('english', content, plainto_tsquery('english', ${query})) AS snippet,
          ts_rank(content_tsv, plainto_tsquery('english', ${query})) AS rank
        FROM summaries
        WHERE conversation_id = ${conversationId}
          AND content_tsv @@ plainto_tsquery('english', ${query})
        ORDER BY rank DESC
        LIMIT ${limit}
      `;
      return rows.map(toSearchResult);
    }

    const rows = await this.sql<SummarySearchRow[]>`
      SELECT
        summary_id,
        conversation_id,
        kind,
        ts_headline('english', content, plainto_tsquery('english', ${query})) AS snippet,
        ts_rank(content_tsv, plainto_tsquery('english', ${query})) AS rank
      FROM summaries
      WHERE content_tsv @@ plainto_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT ${limit}
    `;
    return rows.map(toSearchResult);
  }

  private async searchRegex(
    pattern: string,
    limit: number,
    conversationId?: number,
  ): Promise<SummarySearchResult[]> {
    if (conversationId != null) {
      const rows = await this.sql<SummarySearchRow[]>`
        SELECT
          summary_id,
          conversation_id,
          kind,
          substring(content FROM ${pattern}) AS snippet,
          0 AS rank
        FROM summaries
        WHERE conversation_id = ${conversationId}
          AND content ~ ${pattern}
        ORDER BY created_at
        LIMIT ${limit}
      `;
      return rows.map(toSearchResult);
    }

    const rows = await this.sql<SummarySearchRow[]>`
      SELECT
        summary_id,
        conversation_id,
        kind,
        substring(content FROM ${pattern}) AS snippet,
        0 AS rank
      FROM summaries
      WHERE content ~ ${pattern}
      ORDER BY summary_id
      LIMIT ${limit}
    `;
    return rows.map(toSearchResult);
  }

  // ── Large files ───────────────────────────────────────────────────────────

  async insertLargeFile(input: CreateLargeFileInput): Promise<LargeFileRecord> {
    const [row] = await this.sql<LargeFileRow[]>`
      INSERT INTO large_files (file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary)
      VALUES (
        ${input.fileId},
        ${input.conversationId},
        ${input.fileName ?? null},
        ${input.mimeType ?? null},
        ${input.byteSize ?? null},
        ${input.storageUri},
        ${input.explorationSummary ? escNull(input.explorationSummary) : null}
      )
      RETURNING file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
    `;
    return toLargeFileRecord(row);
  }

  async getLargeFile(fileId: string): Promise<LargeFileRecord | null> {
    const rows = await this.sql<LargeFileRow[]>`
      SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
      FROM large_files
      WHERE file_id = ${fileId}
    `;
    return rows[0] ? toLargeFileRecord(rows[0]) : null;
  }

  async getLargeFilesByConversation(conversationId: number): Promise<LargeFileRecord[]> {
    const rows = await this.sql<LargeFileRow[]>`
      SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
      FROM large_files
      WHERE conversation_id = ${conversationId}
      ORDER BY created_at
    `;
    return rows.map(toLargeFileRecord);
  }
}
