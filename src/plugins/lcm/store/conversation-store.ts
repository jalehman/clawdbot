import type postgres from "postgres";

export type ConversationId = number;
export type MessageId = number;
export type SummaryId = string;
export type MessageRole = "system" | "user" | "assistant" | "tool";

export type CreateMessageInput = {
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
};

export type MessageRecord = {
  messageId: MessageId;
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
  createdAt: Date;
};

export type CreateConversationInput = {
  sessionId: string;
  title?: string;
};

export type ConversationRecord = {
  conversationId: ConversationId;
  sessionId: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MessageSearchInput = {
  conversationId?: ConversationId;
  query: string;
  mode: "regex" | "full_text";
  limit?: number;
};

export type MessageSearchResult = {
  messageId: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  snippet: string;
  rank?: number;
};

/** Escape null bytes (0x00) which PostgreSQL text columns reject. */
const escNull = (s: string) => s.replaceAll("\0", "\\x00");

// ── DB row shapes (snake_case) ────────────────────────────────────────────────

interface ConversationRow {
  conversation_id: number;
  session_id: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  message_id: number;
  conversation_id: number;
  seq: number;
  role: MessageRole;
  content: string;
  token_count: number;
  created_at: Date;
}

interface MessageSearchRow {
  message_id: number;
  conversation_id: number;
  role: MessageRole;
  snippet: string;
  rank: number;
}

interface CountRow {
  count: number;
}

interface MaxSeqRow {
  max_seq: number;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function toConversationRecord(row: ConversationRow): ConversationRecord {
  return {
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    tokenCount: row.token_count,
    createdAt: row.created_at,
  };
}

function toSearchResult(row: MessageSearchRow): MessageSearchResult {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    role: row.role,
    snippet: row.snippet,
    rank: row.rank,
  };
}

// ── ConversationStore ─────────────────────────────────────────────────────────

export class ConversationStore {
  constructor(private sql: ReturnType<typeof postgres>) {}

  // ── Conversation operations ───────────────────────────────────────────────

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    const [row] = await this.sql<ConversationRow[]>`
      INSERT INTO conversations (session_id, title)
      VALUES (${input.sessionId}, ${input.title ?? null})
      RETURNING conversation_id, session_id, title, created_at, updated_at
    `;
    return toConversationRecord(row);
  }

  async getConversation(conversationId: ConversationId): Promise<ConversationRecord | null> {
    const rows = await this.sql<ConversationRow[]>`
      SELECT conversation_id, session_id, title, created_at, updated_at
      FROM conversations
      WHERE conversation_id = ${conversationId}
    `;
    return rows[0] ? toConversationRecord(rows[0]) : null;
  }

  async getConversationBySessionId(sessionId: string): Promise<ConversationRecord | null> {
    const rows = await this.sql<ConversationRow[]>`
      SELECT conversation_id, session_id, title, created_at, updated_at
      FROM conversations
      WHERE session_id = ${sessionId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0] ? toConversationRecord(rows[0]) : null;
  }

  async getOrCreateConversation(sessionId: string, title?: string): Promise<ConversationRecord> {
    const existing = await this.getConversationBySessionId(sessionId);
    if (existing) {
      return existing;
    }
    return this.createConversation({ sessionId, title });
  }

  // ── Message operations ────────────────────────────────────────────────────

  async createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    const [row] = await this.sql<MessageRow[]>`
      INSERT INTO messages (conversation_id, seq, role, content, token_count)
      VALUES (
        ${input.conversationId},
        ${input.seq},
        ${input.role}::message_role,
        ${escNull(input.content)},
        ${input.tokenCount}
      )
      RETURNING message_id, conversation_id, seq, role, content, token_count, created_at
    `;
    return toMessageRecord(row);
  }

  async getMessages(
    conversationId: ConversationId,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<MessageRecord[]> {
    const afterSeq = opts?.afterSeq ?? -1;
    const limit = opts?.limit;

    if (limit != null) {
      const rows = await this.sql<MessageRow[]>`
        SELECT message_id, conversation_id, seq, role, content, token_count, created_at
        FROM messages
        WHERE conversation_id = ${conversationId}
          AND seq > ${afterSeq}
        ORDER BY seq
        LIMIT ${limit}
      `;
      return rows.map(toMessageRecord);
    }

    const rows = await this.sql<MessageRow[]>`
      SELECT message_id, conversation_id, seq, role, content, token_count, created_at
      FROM messages
      WHERE conversation_id = ${conversationId}
        AND seq > ${afterSeq}
      ORDER BY seq
    `;
    return rows.map(toMessageRecord);
  }

  async getMessageById(messageId: MessageId): Promise<MessageRecord | null> {
    const rows = await this.sql<MessageRow[]>`
      SELECT message_id, conversation_id, seq, role, content, token_count, created_at
      FROM messages
      WHERE message_id = ${messageId}
    `;
    return rows[0] ? toMessageRecord(rows[0]) : null;
  }

  async getMessageCount(conversationId: ConversationId): Promise<number> {
    const rows = await this.sql<CountRow[]>`
      SELECT COUNT(*)::int AS count
      FROM messages
      WHERE conversation_id = ${conversationId}
    `;
    return rows[0]?.count ?? 0;
  }

  async getMaxSeq(conversationId: ConversationId): Promise<number> {
    const rows = await this.sql<MaxSeqRow[]>`
      SELECT COALESCE(MAX(seq), 0)::int AS max_seq
      FROM messages
      WHERE conversation_id = ${conversationId}
    `;
    return rows[0]?.max_seq ?? 0;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]> {
    const limit = input.limit ?? 50;

    if (input.mode === "full_text") {
      return this.searchFullText(input.query, limit, input.conversationId);
    }
    return this.searchRegex(input.query, limit, input.conversationId);
  }

  private async searchFullText(
    query: string,
    limit: number,
    conversationId?: ConversationId,
  ): Promise<MessageSearchResult[]> {
    if (conversationId != null) {
      const rows = await this.sql<MessageSearchRow[]>`
        SELECT
          message_id,
          conversation_id,
          role,
          ts_headline('english', content, plainto_tsquery('english', ${query})) AS snippet,
          ts_rank(content_tsv, plainto_tsquery('english', ${query})) AS rank
        FROM messages
        WHERE conversation_id = ${conversationId}
          AND content_tsv @@ plainto_tsquery('english', ${query})
        ORDER BY rank DESC
        LIMIT ${limit}
      `;
      return rows.map(toSearchResult);
    }

    const rows = await this.sql<MessageSearchRow[]>`
      SELECT
        message_id,
        conversation_id,
        role,
        ts_headline('english', content, plainto_tsquery('english', ${query})) AS snippet,
        ts_rank(content_tsv, plainto_tsquery('english', ${query})) AS rank
      FROM messages
      WHERE content_tsv @@ plainto_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT ${limit}
    `;
    return rows.map(toSearchResult);
  }

  private async searchRegex(
    pattern: string,
    limit: number,
    conversationId?: ConversationId,
  ): Promise<MessageSearchResult[]> {
    if (conversationId != null) {
      const rows = await this.sql<MessageSearchRow[]>`
        SELECT
          message_id,
          conversation_id,
          role,
          substring(content FROM ${pattern}) AS snippet,
          0 AS rank
        FROM messages
        WHERE conversation_id = ${conversationId}
          AND content ~ ${pattern}
        ORDER BY seq
        LIMIT ${limit}
      `;
      return rows.map(toSearchResult);
    }

    const rows = await this.sql<MessageSearchRow[]>`
      SELECT
        message_id,
        conversation_id,
        role,
        substring(content FROM ${pattern}) AS snippet,
        0 AS rank
      FROM messages
      WHERE content ~ ${pattern}
      ORDER BY message_id
      LIMIT ${limit}
    `;
    return rows.map(toSearchResult);
  }
}
