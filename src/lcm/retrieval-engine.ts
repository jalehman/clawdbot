import type { LcmStorageBackend } from "./storage/types.js";
import type { TokenEstimator } from "./token-estimator.js";
import type {
  ConversationId,
  MessageId,
  RetrievalAuthorizationInput,
  RetrievalDescribeResult,
  RetrievalEngine,
  RetrievalExpandInput,
  RetrievalExpandResult,
  RetrievalExpandedMessage,
  RetrievalExpandedSummary,
  RetrievalFileDescribeResult,
  RetrievalGrepInput,
  RetrievalGrepMatch,
  RetrievalGrepMode,
  RetrievalGrepResult,
  RetrievalGrepScope,
  RetrievalLineage,
  RetrievalSourceMessageRange,
  RetrievalSummaryDescribeResult,
  SummaryId,
} from "./types.js";
import { ExpansionGrantRegistry } from "./expansion-auth.js";

const DEFAULT_GREP_LIMIT = 20;
const MAX_GREP_LIMIT = 200;
const DEFAULT_REGEX_SCAN_LIMIT = 2_000;
const DEFAULT_EXPAND_DEPTH = 2;
const MAX_EXPAND_DEPTH = 8;
const DEFAULT_EXPAND_LIMIT = 40;
const MAX_EXPAND_LIMIT = 500;
const DEFAULT_EXPAND_TOKEN_CAP = 4_000;
const MAX_EXPAND_TOKEN_CAP = 20_000;
const SNIPPET_CONTEXT = 64;

type RetrievalContextItemRow = {
  item_id: string;
  conversation_id: string;
  source_message_id: string | null;
  item_type: string;
  title: string | null;
  body: string;
  metadata_json: string;
  created_at_ms: number;
};

type RetrievalLineageRow = {
  item_id: string;
};

type RetrievalArtifactRow = {
  artifact_id: string;
  conversation_id: string;
  message_id: string | null;
  path: string;
  mime_type: string | null;
  bytes: number | null;
  sha256: string | null;
  metadata_json: string;
  created_at_ms: number;
};

type RetrievalMessageRow = {
  message_id: string;
  conversation_id: string;
  role: string;
  content_text: string;
  created_at_ms: number;
};

type RetrievalGrepSummaryRow = {
  item_id: string;
  conversation_id: string;
  title: string | null;
  body: string;
  created_at_ms: number;
  score?: number;
};

type RetrievalGrepMessageRow = {
  message_id: string;
  conversation_id: string;
  content_text: string;
  created_at_ms: number;
};

/**
 * Runtime dependencies needed to construct the retrieval engine.
 */
export type CreateLcmRetrievalEngineParams = {
  backend: LcmStorageBackend;
  tokenEstimator: TokenEstimator;
  regexScanLimit?: number;
  expansionAuth?: ExpansionGrantRegistry;
};

/**
 * Create the SQLite retrieval engine implementation.
 */
export function createLcmRetrievalEngine(params: CreateLcmRetrievalEngineParams): RetrievalEngine {
  return new SqliteLcmRetrievalEngine(params);
}

/**
 * SQLite-backed retrieval adapter for describe/grep/expand.
 */
class SqliteLcmRetrievalEngine implements RetrievalEngine {
  private readonly backend: LcmStorageBackend;
  private readonly tokenEstimator: TokenEstimator;
  private readonly regexScanLimit: number;
  private readonly expansionAuth?: ExpansionGrantRegistry;

  /**
   * Construct the retrieval adapter.
   */
  constructor(params: CreateLcmRetrievalEngineParams) {
    this.backend = params.backend;
    this.tokenEstimator = params.tokenEstimator;
    this.regexScanLimit = clampInt(params.regexScanLimit, DEFAULT_REGEX_SCAN_LIMIT, 1, 20_000);
    this.expansionAuth = params.expansionAuth;
  }

  /**
   * Describe either a summary item id or file artifact id.
   */
  async describe(
    id: string,
    auth?: RetrievalAuthorizationInput,
  ): Promise<RetrievalDescribeResult | null> {
    const normalizedId = normalizeId(id);
    if (!normalizedId) {
      return null;
    }

    const summaryRow = this.backend.get<RetrievalContextItemRow>(
      `SELECT item_id, conversation_id, source_message_id, item_type, title, body, metadata_json, created_at_ms
       FROM lcm_context_items
       WHERE item_id = ? AND tombstoned = 0 AND item_type = 'summary'`,
      [normalizedId],
    );
    if (summaryRow) {
      this.authorizeConversationScope({
        auth,
        conversationId: summaryRow.conversation_id,
      });
      return this.buildSummaryDescribe(summaryRow);
    }

    const artifactRow = this.backend.get<RetrievalArtifactRow>(
      `SELECT artifact_id, conversation_id, message_id, path, mime_type, bytes, sha256, metadata_json, created_at_ms
       FROM lcm_artifacts
       WHERE artifact_id = ?`,
      [normalizedId],
    );
    if (artifactRow) {
      this.authorizeConversationScope({
        auth,
        conversationId: artifactRow.conversation_id,
      });
      return this.buildFileDescribe(artifactRow);
    }

    return null;
  }

  /**
   * Execute regex or full-text search over messages/summaries.
   */
  async grep(input: RetrievalGrepInput): Promise<RetrievalGrepResult> {
    const query = normalizeQuery(input.query);
    const mode = normalizeGrepMode(input.mode);
    const scope = normalizeGrepScope(input.scope);
    const limit = clampInt(input.limit, DEFAULT_GREP_LIMIT, 1, MAX_GREP_LIMIT);
    const conversationId = normalizeConversationId(input.conversationId);
    this.authorizeConversationScope({
      auth: input.auth,
      conversationId,
    });

    if (mode === "regex") {
      return this.grepRegex({ query, scope, limit, conversationId });
    }

    return this.grepFullText({ query, scope, limit, conversationId });
  }

  /**
   * Expand a summary id through lineage with depth/token/limit bounds.
   */
  async expand(input: RetrievalExpandInput): Promise<RetrievalExpandResult> {
    const summaryId = normalizeId(input.summaryId);
    if (!summaryId) {
      throw new Error("summaryId is required.");
    }

    const root = this.backend.get<RetrievalContextItemRow>(
      `SELECT item_id, conversation_id, source_message_id, item_type, title, body, metadata_json, created_at_ms
       FROM lcm_context_items
       WHERE item_id = ? AND tombstoned = 0 AND item_type = 'summary'`,
      [summaryId],
    );

    if (!root) {
      const fileRow = this.backend.get<{ artifact_id: string }>(
        "SELECT artifact_id FROM lcm_artifacts WHERE artifact_id = ?",
        [summaryId],
      );
      if (fileRow) {
        throw new Error(
          `expand only supports summary ids. Use describe('${summaryId}') and file readers for file ids.`,
        );
      }
      throw new Error(`summary '${summaryId}' was not found.`);
    }

    const depthLimit = clampInt(input.depth, DEFAULT_EXPAND_DEPTH, 0, MAX_EXPAND_DEPTH);
    const itemLimit = clampInt(input.limit, DEFAULT_EXPAND_LIMIT, 1, MAX_EXPAND_LIMIT);
    const tokenCap = clampInt(input.tokenCap, DEFAULT_EXPAND_TOKEN_CAP, 1, MAX_EXPAND_TOKEN_CAP);
    const includeMessages = input.includeMessages !== false;
    this.authorizeConversationScope({
      auth: input.auth,
      conversationId: root.conversation_id,
      depth: depthLimit,
      tokenCap,
    });

    const queue: Array<{ id: string; depth: number }> = [{ id: root.item_id, depth: 0 }];
    const visited = new Set<string>([root.item_id]);
    const summaries: RetrievalExpandedSummary[] = [];
    const messages: RetrievalExpandedMessage[] = [];
    const nextSummaryIds: SummaryId[] = [];
    const nextSummaryIdSet = new Set<string>();

    let estimatedTokens = 0;
    let truncated = false;

    // Iterative traversal keeps expansion deterministic and bounded.
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      if (current.depth >= depthLimit) {
        continue;
      }

      const children = this.fetchChildItems({
        parentId: current.id,
        conversationId: root.conversation_id,
      });

      for (const child of children) {
        if (visited.has(child.item_id)) {
          continue;
        }
        visited.add(child.item_id);

        const resultItemCount = summaries.length + messages.length;
        if (resultItemCount >= itemLimit) {
          truncated = true;
          if (child.item_type === "summary") {
            pushNextSummaryId(nextSummaryIds, nextSummaryIdSet, child.item_id);
          }
          continue;
        }

        if (child.item_type === "summary") {
          const summary = this.buildExpandedSummary(child, current.depth + 1);
          if (estimatedTokens + summary.tokenEstimate > tokenCap) {
            truncated = true;
            pushNextSummaryId(nextSummaryIds, nextSummaryIdSet, summary.id);
            continue;
          }

          summaries.push(summary);
          estimatedTokens += summary.tokenEstimate;

          if (current.depth + 1 >= depthLimit) {
            if (this.hasSummaryChildren(summary.id)) {
              pushNextSummaryId(nextSummaryIds, nextSummaryIdSet, summary.id);
            }
            continue;
          }

          queue.push({ id: summary.id, depth: current.depth + 1 });
          continue;
        }

        if (!includeMessages || child.item_type !== "message") {
          continue;
        }

        const message = this.buildExpandedMessage(child, current.depth + 1);
        if (!message) {
          continue;
        }
        if (estimatedTokens + message.tokenEstimate > tokenCap) {
          truncated = true;
          continue;
        }

        messages.push(message);
        estimatedTokens += message.tokenEstimate;
      }
    }

    if (queue.length > 0) {
      truncated = true;
      for (const queued of queue) {
        if (queued.id !== root.item_id) {
          pushNextSummaryId(nextSummaryIds, nextSummaryIdSet, queued.id);
        }
      }
    }

    return {
      rootSummaryId: root.item_id as SummaryId,
      conversationId: root.conversation_id as ConversationId,
      summaries,
      messages,
      estimatedTokens,
      truncated,
      nextSummaryIds,
    };
  }

  /**
   * Enforce delegated cross-session expansion scope, when present.
   */
  private authorizeConversationScope(params: {
    auth?: RetrievalAuthorizationInput;
    conversationId?: string;
    depth?: number;
    tokenCap?: number;
  }): void {
    if (!this.expansionAuth) {
      return;
    }
    this.expansionAuth.authorize({
      sessionKey: params.auth?.sessionKey,
      conversationId: params.conversationId as ConversationId | undefined,
      depth: params.depth,
      tokenCap: params.tokenCap,
      nowMs: params.auth?.nowMs,
    });
  }

  /**
   * Build a summary describe result with lineage and source range.
   */
  private buildSummaryDescribe(row: RetrievalContextItemRow): RetrievalSummaryDescribeResult {
    const lineage = this.fetchLineage(row.item_id);
    const sourceMessageRange = this.fetchSourceMessageRange(row.item_id);
    return {
      id: row.item_id as SummaryId,
      kind: "summary",
      conversationId: row.conversation_id as ConversationId,
      itemType: row.item_type,
      title: nullableString(row.title),
      tokenEstimate: this.tokenEstimator.estimateText(`${row.title ?? ""}\n${row.body}`),
      createdAt: toIsoTimestamp(row.created_at_ms),
      metadata: parseJsonObject(row.metadata_json),
      lineage,
      sourceMessageRange,
    };
  }

  /**
   * Build a file describe result from artifact metadata.
   */
  private buildFileDescribe(row: RetrievalArtifactRow): RetrievalFileDescribeResult {
    return {
      id: row.artifact_id,
      kind: "file",
      conversationId: row.conversation_id as ConversationId,
      path: row.path,
      fileName: fileNameFromPath(row.path),
      mimeType: nullableString(row.mime_type),
      bytes: asPositiveNumber(row.bytes),
      sha256: nullableString(row.sha256),
      createdAt: toIsoTimestamp(row.created_at_ms),
      metadata: parseJsonObject(row.metadata_json),
      relatedMessageId: row.message_id ? (row.message_id as MessageId) : undefined,
    };
  }

  /**
   * Grep rows using JS regex evaluation and bounded scan depth.
   */
  private grepRegex(params: {
    query: string;
    scope: RetrievalGrepScope;
    limit: number;
    conversationId?: ConversationId;
  }): RetrievalGrepResult {
    const regex = compileRegex(params.query);
    const rows = this.fetchGrepRows({
      scope: params.scope,
      mode: "regex",
      query: params.query,
      limit: this.regexScanLimit,
      conversationId: params.conversationId,
    });

    const matches: RetrievalGrepMatch[] = [];
    for (const row of rows) {
      const text = row.kind === "message" ? row.content : `${row.title ?? ""}\n${row.content}`;
      const index = firstRegexIndex(regex, text);
      if (index < 0) {
        continue;
      }
      matches.push({
        id: row.id,
        kind: row.kind,
        conversationId: row.conversationId,
        snippet: extractSnippet(text, index),
        createdAt: row.createdAt,
      });
    }

    sortMatches(matches, "regex");
    const limited = matches.slice(0, params.limit);

    return {
      query: params.query,
      mode: "regex",
      scope: params.scope,
      matches: limited,
      truncated: matches.length > params.limit || rows.length >= this.regexScanLimit,
      scannedCount: rows.length,
    };
  }

  /**
   * Grep rows using sqlite FTS (when available) and LIKE fallback.
   */
  private grepFullText(params: {
    query: string;
    scope: RetrievalGrepScope;
    limit: number;
    conversationId?: ConversationId;
  }): RetrievalGrepResult {
    const rows = this.fetchGrepRows({
      scope: params.scope,
      mode: "full_text",
      query: params.query,
      limit: Math.max(params.limit, DEFAULT_GREP_LIMIT),
      conversationId: params.conversationId,
    });

    const normalizedQuery = params.query.toLowerCase();
    const matches = rows.map((row) => {
      const text = row.kind === "message" ? row.content : `${row.title ?? ""}\n${row.content}`;
      const at = text.toLowerCase().indexOf(normalizedQuery);
      return {
        id: row.id,
        kind: row.kind,
        conversationId: row.conversationId,
        snippet: extractSnippet(text, at),
        createdAt: row.createdAt,
        score: row.score,
      } as RetrievalGrepMatch;
    });

    sortMatches(matches, "full_text");
    const limited = matches.slice(0, params.limit);

    return {
      query: params.query,
      mode: "full_text",
      scope: params.scope,
      matches: limited,
      truncated: matches.length > params.limit,
      scannedCount: rows.length,
    };
  }

  /**
   * Read parent and child lineage ids for a summary.
   */
  private fetchLineage(summaryId: string): RetrievalLineage {
    const parents = this.backend.all<RetrievalLineageRow>(
      "SELECT parent_item_id AS item_id FROM lcm_lineage_edges WHERE child_item_id = ? ORDER BY parent_item_id",
      [summaryId],
    );
    const children = this.backend.all<RetrievalLineageRow>(
      "SELECT child_item_id AS item_id FROM lcm_lineage_edges WHERE parent_item_id = ? ORDER BY child_item_id",
      [summaryId],
    );
    return {
      parentIds: parents.map((row) => row.item_id),
      childIds: children.map((row) => row.item_id),
    };
  }

  /**
   * Resolve message range reachable from a summary via lineage.
   */
  private fetchSourceMessageRange(summaryId: string): RetrievalSourceMessageRange | undefined {
    const rows = this.backend.all<{ message_id: string; ordinal: number }>(
      `WITH RECURSIVE descendants(item_id) AS (
         SELECT item_id
         FROM lcm_context_items
         WHERE item_id = ?
         UNION
         SELECT edge.child_item_id
         FROM lcm_lineage_edges edge
         INNER JOIN descendants d ON edge.parent_item_id = d.item_id
       )
       SELECT msg.message_id, msg.ordinal
       FROM descendants d
       INNER JOIN lcm_context_items item ON item.item_id = d.item_id
       INNER JOIN lcm_messages msg ON msg.message_id = COALESCE(item.source_message_id, item.item_id)
       WHERE item.item_type = 'message' AND item.tombstoned = 0
       ORDER BY msg.ordinal ASC`,
      [summaryId],
    );

    if (rows.length === 0) {
      return undefined;
    }

    return {
      startId: rows[0].message_id as MessageId,
      endId: rows[rows.length - 1].message_id as MessageId,
      count: rows.length,
    };
  }

  /**
   * Fetch direct child context items for traversal.
   */
  private fetchChildItems(params: {
    parentId: string;
    conversationId: string;
  }): RetrievalContextItemRow[] {
    return this.backend.all<RetrievalContextItemRow>(
      `SELECT item.item_id, item.conversation_id, item.source_message_id, item.item_type, item.title, item.body,
              item.metadata_json, item.created_at_ms
       FROM lcm_lineage_edges edge
       INNER JOIN lcm_context_items item ON item.item_id = edge.child_item_id
       WHERE edge.parent_item_id = ? AND item.conversation_id = ? AND item.tombstoned = 0
       ORDER BY item.created_at_ms ASC, item.item_id ASC`,
      [params.parentId, params.conversationId],
    );
  }

  /**
   * True when a summary has at least one child edge.
   */
  private hasSummaryChildren(summaryId: string): boolean {
    const row = this.backend.get<{ present: number }>(
      "SELECT 1 AS present FROM lcm_lineage_edges WHERE parent_item_id = ? LIMIT 1",
      [summaryId],
    );
    return Boolean(row?.present);
  }

  /**
   * Build an expanded summary payload.
   */
  private buildExpandedSummary(
    row: RetrievalContextItemRow,
    depth: number,
  ): RetrievalExpandedSummary {
    return {
      id: row.item_id as SummaryId,
      conversationId: row.conversation_id as ConversationId,
      title: nullableString(row.title),
      body: row.body,
      depth,
      createdAt: toIsoTimestamp(row.created_at_ms),
      tokenEstimate: this.tokenEstimator.estimateText(`${row.title ?? ""}\n${row.body}`),
    };
  }

  /**
   * Build an expanded message payload from a message context item.
   */
  private buildExpandedMessage(
    row: RetrievalContextItemRow,
    depth: number,
  ): RetrievalExpandedMessage | null {
    const messageId = row.source_message_id ?? row.item_id;
    const messageRow = this.backend.get<RetrievalMessageRow>(
      `SELECT message_id, conversation_id, role, content_text, created_at_ms
       FROM lcm_messages
       WHERE message_id = ?`,
      [messageId],
    );
    if (!messageRow) {
      return null;
    }

    return {
      id: messageRow.message_id as MessageId,
      conversationId: messageRow.conversation_id as ConversationId,
      role: normalizeMessageRole(messageRow.role),
      content: messageRow.content_text,
      depth,
      createdAt: toIsoTimestamp(messageRow.created_at_ms),
      tokenEstimate: this.tokenEstimator.estimateText(messageRow.content_text),
    };
  }

  /**
   * Fetch raw grep rows from summaries/messages with bounded SQL limits.
   */
  private fetchGrepRows(params: {
    scope: RetrievalGrepScope;
    mode: RetrievalGrepMode;
    query: string;
    limit: number;
    conversationId?: ConversationId;
  }): Array<{
    id: string;
    kind: "message" | "summary";
    conversationId: ConversationId;
    title?: string;
    content: string;
    createdAt: string;
    score?: number;
  }> {
    const rows: Array<{
      id: string;
      kind: "message" | "summary";
      conversationId: ConversationId;
      title?: string;
      content: string;
      createdAt: string;
      createdAtMs: number;
      score?: number;
    }> = [];

    if (params.scope === "summaries" || params.scope === "both") {
      for (const row of this.fetchSummaryGrepRows(params)) {
        rows.push({
          id: row.item_id,
          kind: "summary",
          conversationId: row.conversation_id as ConversationId,
          title: nullableString(row.title) ?? undefined,
          content: row.body,
          createdAt: toIsoTimestamp(row.created_at_ms),
          createdAtMs: row.created_at_ms,
          score: row.score,
        });
      }
    }

    if (params.scope === "messages" || params.scope === "both") {
      for (const row of this.fetchMessageGrepRows(params)) {
        rows.push({
          id: row.message_id,
          kind: "message",
          conversationId: row.conversation_id as ConversationId,
          content: row.content_text,
          createdAt: toIsoTimestamp(row.created_at_ms),
          createdAtMs: row.created_at_ms,
        });
      }
    }

    if (params.mode === "regex") {
      rows.sort((a, b) => compareByCreatedAtMsDesc(a.createdAtMs, b.createdAtMs));
    }

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      conversationId: row.conversationId,
      title: row.title,
      content: row.content,
      createdAt: row.createdAt,
      score: row.score,
    }));
  }

  /**
   * Fetch summary rows for grep using FTS when available.
   */
  private fetchSummaryGrepRows(params: {
    mode: RetrievalGrepMode;
    query: string;
    limit: number;
    conversationId?: ConversationId;
  }): RetrievalGrepSummaryRow[] {
    const conversationId = params.conversationId;

    if (params.mode === "full_text" && this.backend.ftsAvailable) {
      if (conversationId) {
        return this.backend.all<RetrievalGrepSummaryRow>(
          `SELECT item.item_id, item.conversation_id, item.title, item.body, item.created_at_ms,
                  bm25(lcm_context_items_fts) AS score
           FROM lcm_context_items_fts
           INNER JOIN lcm_context_items item ON item.rowid = lcm_context_items_fts.rowid
           WHERE lcm_context_items_fts MATCH ?
             AND item.item_type = 'summary'
             AND item.tombstoned = 0
             AND item.conversation_id = ?
           ORDER BY score ASC, item.created_at_ms DESC
           LIMIT ?`,
          [params.query, conversationId, params.limit],
        );
      }
      return this.backend.all<RetrievalGrepSummaryRow>(
        `SELECT item.item_id, item.conversation_id, item.title, item.body, item.created_at_ms,
                bm25(lcm_context_items_fts) AS score
         FROM lcm_context_items_fts
         INNER JOIN lcm_context_items item ON item.rowid = lcm_context_items_fts.rowid
         WHERE lcm_context_items_fts MATCH ?
           AND item.item_type = 'summary'
           AND item.tombstoned = 0
         ORDER BY score ASC, item.created_at_ms DESC
         LIMIT ?`,
        [params.query, params.limit],
      );
    }

    const likeQuery = `%${params.query.toLowerCase()}%`;
    if (conversationId) {
      return this.backend.all<RetrievalGrepSummaryRow>(
        `SELECT item_id, conversation_id, title, body, created_at_ms
         FROM lcm_context_items
         WHERE item_type = 'summary'
           AND tombstoned = 0
           AND conversation_id = ?
           AND lower(COALESCE(title, '') || ' ' || body) LIKE ?
         ORDER BY created_at_ms DESC
         LIMIT ?`,
        [conversationId, likeQuery, params.limit],
      );
    }

    return this.backend.all<RetrievalGrepSummaryRow>(
      `SELECT item_id, conversation_id, title, body, created_at_ms
       FROM lcm_context_items
       WHERE item_type = 'summary'
         AND tombstoned = 0
         AND lower(COALESCE(title, '') || ' ' || body) LIKE ?
       ORDER BY created_at_ms DESC
       LIMIT ?`,
      [likeQuery, params.limit],
    );
  }

  /**
   * Fetch message rows for grep.
   */
  private fetchMessageGrepRows(params: {
    mode: RetrievalGrepMode;
    query: string;
    limit: number;
    conversationId?: ConversationId;
  }): RetrievalGrepMessageRow[] {
    if (params.mode === "regex") {
      if (params.conversationId) {
        return this.backend.all<RetrievalGrepMessageRow>(
          `SELECT message_id, conversation_id, content_text, created_at_ms
           FROM lcm_messages
           WHERE conversation_id = ?
           ORDER BY created_at_ms DESC
           LIMIT ?`,
          [params.conversationId, params.limit],
        );
      }

      return this.backend.all<RetrievalGrepMessageRow>(
        `SELECT message_id, conversation_id, content_text, created_at_ms
         FROM lcm_messages
         ORDER BY created_at_ms DESC
         LIMIT ?`,
        [params.limit],
      );
    }

    const likeQuery = `%${params.query.toLowerCase()}%`;
    if (params.conversationId) {
      return this.backend.all<RetrievalGrepMessageRow>(
        `SELECT message_id, conversation_id, content_text, created_at_ms
         FROM lcm_messages
         WHERE conversation_id = ?
           AND lower(content_text) LIKE ?
         ORDER BY created_at_ms DESC
         LIMIT ?`,
        [params.conversationId, likeQuery, params.limit],
      );
    }

    return this.backend.all<RetrievalGrepMessageRow>(
      `SELECT message_id, conversation_id, content_text, created_at_ms
       FROM lcm_messages
       WHERE lower(content_text) LIKE ?
       ORDER BY created_at_ms DESC
       LIMIT ?`,
      [likeQuery, params.limit],
    );
  }
}

function normalizeId(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeQuery(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("query is required.");
  }
  return normalized;
}

function normalizeConversationId(value: ConversationId | undefined): ConversationId | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return undefined;
  }
  return normalized as ConversationId;
}

function normalizeGrepMode(value: RetrievalGrepMode | undefined): RetrievalGrepMode {
  if (value === "regex") {
    return "regex";
  }
  return "full_text";
}

function normalizeGrepScope(value: RetrievalGrepScope | undefined): RetrievalGrepScope {
  if (value === "messages" || value === "summaries") {
    return value;
  }
  return "both";
}

function normalizeMessageRole(value: string): "system" | "user" | "assistant" | "tool" {
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") {
    return value;
  }
  return "tool";
}

function toIsoTimestamp(input: number): string {
  return new Date(input).toISOString();
}

function parseJsonObject(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function compileRegex(query: string): RegExp {
  const literal = query.match(/^\/(.*)\/([a-z]*)$/i);
  if (literal) {
    const [, pattern, rawFlags] = literal;
    const flags = dedupeRegexFlags(rawFlags);
    return new RegExp(pattern, flags);
  }
  return new RegExp(query, "i");
}

function dedupeRegexFlags(flags: string): string {
  const allowed = new Set(["d", "g", "i", "m", "s", "u", "v", "y"]);
  const deduped = new Set<string>();
  for (const flag of flags) {
    if (allowed.has(flag)) {
      deduped.add(flag);
    }
  }
  return Array.from(deduped).join("");
}

function firstRegexIndex(regex: RegExp, text: string): number {
  const target = regex.global ? new RegExp(regex.source, regex.flags.replace("g", "")) : regex;
  const matched = target.exec(text);
  return matched?.index ?? -1;
}

function extractSnippet(text: string, index: number): string {
  const safeIndex = index >= 0 ? index : 0;
  const start = Math.max(0, safeIndex - SNIPPET_CONTEXT);
  const end = Math.min(text.length, safeIndex + SNIPPET_CONTEXT);
  return (
    text.slice(start, end).trim() || text.slice(0, Math.min(text.length, SNIPPET_CONTEXT)).trim()
  );
}

function sortMatches(matches: RetrievalGrepMatch[], mode: RetrievalGrepMode): void {
  matches.sort((a, b) => {
    if (mode === "full_text") {
      const aScore = a.score;
      const bScore = b.score;
      if (aScore !== undefined && bScore !== undefined && aScore !== bScore) {
        return aScore - bScore;
      }
      if (aScore !== undefined && bScore === undefined) {
        return -1;
      }
      if (aScore === undefined && bScore !== undefined) {
        return 1;
      }
    }

    const byCreated = compareByCreatedAtDesc(a.createdAt, b.createdAt);
    if (byCreated !== 0) {
      return byCreated;
    }
    return a.id.localeCompare(b.id);
  });
}

function compareByCreatedAtDesc(aIso: string, bIso: string): number {
  return compareByCreatedAtMsDesc(Date.parse(aIso), Date.parse(bIso));
}

function compareByCreatedAtMsDesc(a: number, b: number): number {
  return b - a;
}

function nullableString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveNumber(value: number | null): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value >= 0 ? value : undefined;
}

function fileNameFromPath(pathValue: string): string | undefined {
  const normalized = pathValue.trim();
  if (!normalized) {
    return undefined;
  }
  const pieces = normalized.split(/[\\/]/);
  return pieces[pieces.length - 1] || undefined;
}

function clampInt(
  value: number | undefined,
  fallback: number,
  minValue: number,
  maxValue: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maxValue, Math.max(minValue, Math.trunc(value)));
}

function pushNextSummaryId(target: SummaryId[], seen: Set<string>, summaryId: string): void {
  if (seen.has(summaryId)) {
    return;
  }
  seen.add(summaryId);
  target.push(summaryId as SummaryId);
}
