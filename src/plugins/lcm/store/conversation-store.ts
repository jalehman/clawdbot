import type { DatabaseSync } from "node:sqlite";

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

// ── DB row shapes (snake_case) ────────────────────────────────────────────────

interface ConversationRow {
  conversation_id: number;
  session_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  message_id: number;
  conversation_id: number;
  seq: number;
  role: MessageRole;
  content: string;
  token_count: number;
  created_at: string;
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
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
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
    createdAt: new Date(row.created_at),
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
  constructor(private db: DatabaseSync) {}

  // ── Conversation operations ───────────────────────────────────────────────

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    const result = this.db.prepare(
      `INSERT INTO conversations (session_id, title) VALUES (?, ?)`,
    ).run(input.sessionId, input.title ?? null);

    const row = this.db.prepare(
      `SELECT conversation_id, session_id, title, created_at, updated_at
       FROM conversations WHERE conversation_id = ?`,
    ).get(Number(result.lastInsertRowid)) as unknown as ConversationRow;

    return toConversationRecord(row);
  }

  async getConversation(conversationId: ConversationId): Promise<ConversationRecord | null> {
    const row = this.db.prepare(
      `SELECT conversation_id, session_id, title, created_at, updated_at
       FROM conversations WHERE conversation_id = ?`,
    ).get(conversationId) as unknown as ConversationRow | undefined;

    return row ? toConversationRecord(row) : null;
  }

  async getConversationBySessionId(sessionId: string): Promise<ConversationRecord | null> {
    const row = this.db.prepare(
      `SELECT conversation_id, session_id, title, created_at, updated_at
       FROM conversations
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(sessionId) as unknown as ConversationRow | undefined;

    return row ? toConversationRecord(row) : null;
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
    const result = this.db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      input.conversationId,
      input.seq,
      input.role,
      input.content,
      input.tokenCount,
    );

    const messageId = Number(result.lastInsertRowid);

    // Index in FTS5
    this.db.prepare(
      `INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`,
    ).run(messageId, input.content);

    const row = this.db.prepare(
      `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
       FROM messages WHERE message_id = ?`,
    ).get(messageId) as unknown as MessageRow;

    return toMessageRecord(row);
  }

  async getMessages(
    conversationId: ConversationId,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<MessageRecord[]> {
    const afterSeq = opts?.afterSeq ?? -1;
    const limit = opts?.limit;

    if (limit != null) {
      const rows = this.db.prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages
         WHERE conversation_id = ? AND seq > ?
         ORDER BY seq
         LIMIT ?`,
      ).all(conversationId, afterSeq, limit) as unknown as MessageRow[];
      return rows.map(toMessageRecord);
    }

    const rows = this.db.prepare(
      `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
       FROM messages
       WHERE conversation_id = ? AND seq > ?
       ORDER BY seq`,
    ).all(conversationId, afterSeq) as unknown as MessageRow[];
    return rows.map(toMessageRecord);
  }

  async getMessageById(messageId: MessageId): Promise<MessageRecord | null> {
    const row = this.db.prepare(
      `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
       FROM messages WHERE message_id = ?`,
    ).get(messageId) as unknown as MessageRow | undefined;
    return row ? toMessageRecord(row) : null;
  }

  async getMessageCount(conversationId: ConversationId): Promise<number> {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?`,
    ).get(conversationId) as unknown as CountRow;
    return row?.count ?? 0;
  }

  async getMaxSeq(conversationId: ConversationId): Promise<number> {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(seq), 0) AS max_seq
       FROM messages WHERE conversation_id = ?`,
    ).get(conversationId) as unknown as MaxSeqRow;
    return row?.max_seq ?? 0;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]> {
    const limit = input.limit ?? 50;

    if (input.mode === "full_text") {
      return this.searchFullText(input.query, limit, input.conversationId);
    }
    return this.searchRegex(input.query, limit, input.conversationId);
  }

  private searchFullText(
    query: string,
    limit: number,
    conversationId?: ConversationId,
  ): MessageSearchResult[] {
    if (conversationId != null) {
      const rows = this.db.prepare(
        `SELECT
           m.message_id,
           m.conversation_id,
           m.role,
           snippet(messages_fts, 0, '', '', '...', 32) AS snippet,
           messages_fts.rank
         FROM messages_fts
         JOIN messages m ON m.message_id = messages_fts.rowid
         WHERE messages_fts MATCH ?
           AND m.conversation_id = ?
         ORDER BY messages_fts.rank
         LIMIT ?`,
      ).all(query, conversationId, limit) as unknown as MessageSearchRow[];
      return rows.map(toSearchResult);
    }

    const rows = this.db.prepare(
      `SELECT
         m.message_id,
         m.conversation_id,
         m.role,
         snippet(messages_fts, 0, '', '', '...', 32) AS snippet,
         messages_fts.rank
       FROM messages_fts
       JOIN messages m ON m.message_id = messages_fts.rowid
       WHERE messages_fts MATCH ?
       ORDER BY messages_fts.rank
       LIMIT ?`,
    ).all(query, limit) as unknown as MessageSearchRow[];
    return rows.map(toSearchResult);
  }

  private searchRegex(
    pattern: string,
    limit: number,
    conversationId?: ConversationId,
  ): MessageSearchResult[] {
    // SQLite has no native POSIX regex; fetch candidates and filter in JS
    const re = new RegExp(pattern);

    let rows: MessageRow[];
    if (conversationId != null) {
      rows = this.db.prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages
         WHERE conversation_id = ?
         ORDER BY seq`,
      ).all(conversationId) as unknown as MessageRow[];
    } else {
      rows = this.db.prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages
         ORDER BY message_id`,
      ).all() as unknown as MessageRow[];
    }

    const results: MessageSearchResult[] = [];
    for (const row of rows) {
      if (results.length >= limit) break;
      const match = re.exec(row.content);
      if (match) {
        results.push({
          messageId: row.message_id,
          conversationId: row.conversation_id,
          role: row.role,
          snippet: match[0],
          rank: 0,
        });
      }
    }
    return results;
  }
}
