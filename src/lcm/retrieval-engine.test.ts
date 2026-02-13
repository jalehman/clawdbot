import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId, SummaryId } from "./types.js";
import { ExpansionGrantRegistry } from "./expansion-auth.js";
import { createLcmRetrievalEngine } from "./retrieval-engine.js";
import { SqliteLcmStorageBackend } from "./storage/sqlite.js";
import { createPlaceholderTokenEstimator } from "./token-estimator.js";

const OPEN_HANDLES = new Set<SqliteLcmStorageBackend>();
const OPEN_DIRS = new Set<string>();

afterEach(async () => {
  for (const backend of OPEN_HANDLES) {
    await backend.close();
  }
  OPEN_HANDLES.clear();

  for (const dir of OPEN_DIRS) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  OPEN_DIRS.clear();
});

describe("createLcmRetrievalEngine", () => {
  it("describes summary ids with lineage and source message range", async () => {
    const { backend, retrieval } = await createHarness();
    const now = 1_700_000_000_000;

    insertConversation(backend, { conversationId: "conv-alpha", now });
    insertMessage(backend, {
      conversationId: "conv-alpha",
      messageId: "msg-1",
      ordinal: 1,
      role: "user",
      content: "Deployment checklist needs verification.",
      now,
    });

    insertSummaryItem(backend, {
      conversationId: "conv-alpha",
      itemId: "sum-parent",
      title: "Parent Summary",
      body: "Top-level project context.",
      now: now + 1,
    });
    insertSummaryItem(backend, {
      conversationId: "conv-alpha",
      itemId: "sum-root",
      title: "Root Summary",
      body: "Deployment plan overview.",
      now: now + 2,
      metadata: { source: "compaction" },
    });
    insertSummaryItem(backend, {
      conversationId: "conv-alpha",
      itemId: "sum-child",
      title: "Child Summary",
      body: "Checklist detail branch.",
      now: now + 3,
    });
    insertMessageItem(backend, {
      conversationId: "conv-alpha",
      itemId: "item-msg-1",
      sourceMessageId: "msg-1",
      body: "Message pointer",
      now: now + 4,
    });

    insertEdge(backend, { parentId: "sum-parent", childId: "sum-root", now: now + 5 });
    insertEdge(backend, { parentId: "sum-root", childId: "sum-child", now: now + 6 });
    insertEdge(backend, { parentId: "sum-child", childId: "item-msg-1", now: now + 7 });

    const result = await retrieval.describe("sum-root");
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("summary");

    if (!result || result.kind !== "summary") {
      throw new Error("expected summary describe result");
    }

    expect(result.id).toBe("sum-root");
    expect(result.conversationId).toBe("conv-alpha");
    expect(result.lineage.parentIds).toEqual(["sum-parent"]);
    expect(result.lineage.childIds).toEqual(["sum-child"]);
    expect(result.metadata).toEqual({ source: "compaction" });
    expect(result.sourceMessageRange).toEqual({
      startId: "msg-1",
      endId: "msg-1",
      count: 1,
    });
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it("describes file ids from artifacts", async () => {
    const { backend, retrieval } = await createHarness();
    const now = 1_700_000_001_000;

    insertConversation(backend, { conversationId: "conv-alpha", now });
    insertMessage(backend, {
      conversationId: "conv-alpha",
      messageId: "msg-file",
      ordinal: 1,
      role: "assistant",
      content: "Attached postmortem PDF.",
      now,
    });
    insertArtifact(backend, {
      artifactId: "file-postmortem",
      conversationId: "conv-alpha",
      messageId: "msg-file",
      artifactPath: "/tmp/postmortem-2026.pdf",
      mimeType: "application/pdf",
      bytes: 2048,
      sha256: "abc123",
      now: now + 10,
      metadata: { source: "upload" },
    });

    const result = await retrieval.describe("file-postmortem");
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("file");

    if (!result || result.kind !== "file") {
      throw new Error("expected file describe result");
    }

    expect(result.id).toBe("file-postmortem");
    expect(result.path).toBe("/tmp/postmortem-2026.pdf");
    expect(result.fileName).toBe("postmortem-2026.pdf");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.bytes).toBe(2048);
    expect(result.metadata).toEqual({ source: "upload" });
    expect(result.relatedMessageId).toBe("msg-file");
  });

  it("returns null when id does not exist", async () => {
    const { retrieval } = await createHarness();
    const result = await retrieval.describe("missing-id");
    expect(result).toBeNull();
  });

  it("grep supports full_text search across both scopes", async () => {
    const { backend, retrieval } = await createHarness();
    const now = 1_700_000_002_000;

    insertConversation(backend, { conversationId: "conv-alpha", now });
    insertConversation(backend, { conversationId: "conv-beta", now: now + 1 });

    insertMessage(backend, {
      conversationId: "conv-alpha",
      messageId: "msg-alpha",
      ordinal: 1,
      role: "assistant",
      content: "Investigating latency spikes in deploy window.",
      now: now + 2,
    });
    insertMessage(backend, {
      conversationId: "conv-beta",
      messageId: "msg-beta",
      ordinal: 1,
      role: "assistant",
      content: "No latency alerts observed.",
      now: now + 3,
    });

    insertSummaryItem(backend, {
      conversationId: "conv-alpha",
      itemId: "sum-latency",
      title: "Latency Summary",
      body: "Latency spikes happened near rollout.",
      now: now + 4,
    });
    insertSummaryItem(backend, {
      conversationId: "conv-beta",
      itemId: "sum-other",
      title: "Other Summary",
      body: "Completely unrelated history.",
      now: now + 5,
    });

    const result = await retrieval.grep({
      query: "latency",
      mode: "full_text",
      scope: "both",
      conversationId: "conv-alpha" as ConversationId,
      limit: 10,
    });

    expect(result.mode).toBe("full_text");
    expect(result.scope).toBe("both");
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    expect(result.matches.every((match) => match.conversationId === "conv-alpha")).toBe(true);
    const matchKinds = new Set(result.matches.map((match) => match.kind));
    expect(matchKinds.has("message")).toBe(true);
    expect(matchKinds.has("summary")).toBe(true);
  });

  it("grep supports regex mode with bounded limit", async () => {
    const { backend, retrieval } = await createHarness();
    const now = 1_700_000_003_000;

    insertConversation(backend, { conversationId: "conv-alpha", now });
    insertMessage(backend, {
      conversationId: "conv-alpha",
      messageId: "msg-err-1",
      ordinal: 1,
      role: "tool",
      content: "ERR-120: build failed",
      now: now + 1,
    });
    insertMessage(backend, {
      conversationId: "conv-alpha",
      messageId: "msg-err-2",
      ordinal: 2,
      role: "tool",
      content: "ERR-240: deploy failed",
      now: now + 2,
    });
    insertMessage(backend, {
      conversationId: "conv-alpha",
      messageId: "msg-ok",
      ordinal: 3,
      role: "assistant",
      content: "Recovered successfully.",
      now: now + 3,
    });

    const result = await retrieval.grep({
      query: "ERR-[0-9]+",
      mode: "regex",
      scope: "messages",
      conversationId: "conv-alpha" as ConversationId,
      limit: 1,
    });

    expect(result.mode).toBe("regex");
    expect(result.scope).toBe("messages");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.snippet).toContain("ERR-");
    expect(result.truncated).toBe(true);
    expect(result.scannedCount).toBeGreaterThanOrEqual(3);
  });

  it("expand enforces depth bounds and returns follow-up summary ids", async () => {
    const { backend, retrieval } = await createHarness();
    const now = 1_700_000_004_000;

    seedExpansionGraph(backend, { conversationId: "conv-alpha", now });

    const result = await retrieval.expand({
      summaryId: "sum-root" as SummaryId,
      depth: 1,
      includeMessages: false,
      tokenCap: 4_000,
      limit: 20,
    });

    expect(result.rootSummaryId).toBe("sum-root");
    expect(result.summaries.map((summary) => summary.id)).toEqual(["sum-a"]);
    expect(result.messages).toHaveLength(0);
    expect(result.nextSummaryIds).toContain("sum-a");
  });

  it("expand enforces token caps and marks truncation", async () => {
    const { backend, retrieval } = await createHarness();
    const now = 1_700_000_005_000;

    insertConversation(backend, { conversationId: "conv-alpha", now });
    insertSummaryItem(backend, {
      conversationId: "conv-alpha",
      itemId: "sum-root",
      title: "Root",
      body: "Root summary",
      now: now + 1,
    });
    insertSummaryItem(backend, {
      conversationId: "conv-alpha",
      itemId: "sum-huge",
      title: "Huge",
      body: "x".repeat(1200),
      now: now + 2,
    });
    insertEdge(backend, { parentId: "sum-root", childId: "sum-huge", now: now + 3 });

    const result = await retrieval.expand({
      summaryId: "sum-root" as SummaryId,
      depth: 3,
      includeMessages: true,
      tokenCap: 10,
      limit: 20,
    });

    expect(result.summaries).toHaveLength(0);
    expect(result.messages).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(result.nextSummaryIds).toContain("sum-huge");
    expect(result.estimatedTokens).toBe(0);
  });

  it("expand rejects file ids and directs callers to describe", async () => {
    const { backend, retrieval } = await createHarness();
    const now = 1_700_000_006_000;

    insertConversation(backend, { conversationId: "conv-alpha", now });
    insertArtifact(backend, {
      artifactId: "file-blob",
      conversationId: "conv-alpha",
      artifactPath: "/tmp/blob.bin",
      now: now + 1,
    });

    await expect(
      retrieval.expand({
        summaryId: "file-blob" as SummaryId,
      }),
    ).rejects.toThrow(/expand only supports summary ids/i);
  });

  it("rejects unauthorized cross-session expansion outside delegated scope", async () => {
    const expansionAuth = new ExpansionGrantRegistry();
    const { backend, retrieval } = await createHarness({ expansionAuth });
    const now = 1_700_000_007_000;

    insertConversation(backend, { conversationId: "conv-alpha", now });
    insertSummaryItem(backend, {
      conversationId: "conv-alpha",
      itemId: "sum-alpha-root",
      title: "Alpha Root",
      body: "Alpha branch",
      now: now + 1,
    });

    insertConversation(backend, { conversationId: "conv-beta", now: now + 2 });
    insertSummaryItem(backend, {
      conversationId: "conv-beta",
      itemId: "sum-beta-root",
      title: "Beta Root",
      body: "Beta branch",
      now: now + 3,
    });

    expansionAuth.issueGrant({
      delegatorSessionKey: "agent:main:main",
      delegateSessionKey: "agent:main:subagent:scope",
      conversationIds: ["conv-alpha"],
      maxDepth: 2,
      maxTokenCap: 4_000,
      ttlMs: 60_000,
      nowMs: now + 4,
    });

    await expect(
      retrieval.expand({
        summaryId: "sum-beta-root" as SummaryId,
        depth: 1,
        tokenCap: 1_000,
        auth: {
          sessionKey: "agent:main:subagent:scope",
          nowMs: now + 5,
        },
      }),
    ).rejects.toThrow(/outside delegated expansion scope/i);
  });

  it("rejects unscoped grep when a cross-session grant is active", async () => {
    const expansionAuth = new ExpansionGrantRegistry();
    const { backend, retrieval } = await createHarness({ expansionAuth });
    const now = 1_700_000_008_000;

    insertConversation(backend, { conversationId: "conv-alpha", now });
    insertMessage(backend, {
      conversationId: "conv-alpha",
      messageId: "msg-alpha-1",
      ordinal: 1,
      role: "assistant",
      content: "Auth handoff timeline",
      now: now + 1,
    });

    expansionAuth.issueGrant({
      delegatorSessionKey: "agent:main:main",
      delegateSessionKey: "agent:main:subagent:grep",
      conversationIds: ["conv-alpha"],
      maxDepth: 2,
      maxTokenCap: 4_000,
      ttlMs: 60_000,
      nowMs: now + 2,
    });

    await expect(
      retrieval.grep({
        query: "handoff",
        mode: "regex",
        scope: "messages",
        auth: {
          sessionKey: "agent:main:subagent:grep",
          nowMs: now + 3,
        },
      }),
    ).rejects.toThrow(/requires a scoped conversationId/i);
  });
});

async function createHarness(params?: { expansionAuth?: ExpansionGrantRegistry }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lcm-retrieval-"));
  OPEN_DIRS.add(dir);

  const backend = new SqliteLcmStorageBackend({
    dbPath: path.join(dir, "lcm.sqlite"),
  });
  OPEN_HANDLES.add(backend);

  await backend.migrate();

  const retrieval = createLcmRetrievalEngine({
    backend,
    tokenEstimator: createPlaceholderTokenEstimator(),
    expansionAuth: params?.expansionAuth,
  });

  return { backend, retrieval };
}

function insertConversation(
  backend: SqliteLcmStorageBackend,
  params: { conversationId: string; now: number },
): void {
  backend.execute(
    `INSERT INTO lcm_conversations (conversation_id, session_id, channel, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
    [params.conversationId, `${params.conversationId}-session`, "test", params.now, params.now],
  );
}

function insertMessage(
  backend: SqliteLcmStorageBackend,
  params: {
    conversationId: string;
    messageId: string;
    ordinal: number;
    role: string;
    content: string;
    now: number;
  },
): void {
  backend.execute(
    `INSERT INTO lcm_messages (message_id, conversation_id, ordinal, role, author_id, content_text, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.messageId,
      params.conversationId,
      params.ordinal,
      params.role,
      null,
      params.content,
      "{}",
      params.now,
    ],
  );
}

function insertSummaryItem(
  backend: SqliteLcmStorageBackend,
  params: {
    conversationId: string;
    itemId: string;
    title: string;
    body: string;
    now: number;
    metadata?: Record<string, unknown>;
  },
): void {
  backend.execute(
    `INSERT INTO lcm_context_items (
      item_id, conversation_id, source_message_id, item_type, depth, title, body,
      metadata_json, tombstoned, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.itemId,
      params.conversationId,
      null,
      "summary",
      0,
      params.title,
      params.body,
      JSON.stringify(params.metadata ?? {}),
      0,
      params.now,
      params.now,
    ],
  );
}

function insertMessageItem(
  backend: SqliteLcmStorageBackend,
  params: {
    conversationId: string;
    itemId: string;
    sourceMessageId: string;
    body: string;
    now: number;
  },
): void {
  backend.execute(
    `INSERT INTO lcm_context_items (
      item_id, conversation_id, source_message_id, item_type, depth, title, body,
      metadata_json, tombstoned, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.itemId,
      params.conversationId,
      params.sourceMessageId,
      "message",
      0,
      null,
      params.body,
      "{}",
      0,
      params.now,
      params.now,
    ],
  );
}

function insertEdge(
  backend: SqliteLcmStorageBackend,
  params: { parentId: string; childId: string; now: number },
): void {
  backend.execute(
    `INSERT INTO lcm_lineage_edges (parent_item_id, child_item_id, relation, metadata_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
    [params.parentId, params.childId, "derived", "{}", params.now],
  );
}

function insertArtifact(
  backend: SqliteLcmStorageBackend,
  params: {
    artifactId: string;
    conversationId: string;
    artifactPath: string;
    now: number;
    messageId?: string;
    mimeType?: string;
    bytes?: number;
    sha256?: string;
    metadata?: Record<string, unknown>;
  },
): void {
  backend.execute(
    `INSERT INTO lcm_artifacts (
      artifact_id, conversation_id, message_id, part_id, path, mime_type, bytes, sha256, metadata_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.artifactId,
      params.conversationId,
      params.messageId ?? null,
      null,
      params.artifactPath,
      params.mimeType ?? null,
      params.bytes ?? null,
      params.sha256 ?? null,
      JSON.stringify(params.metadata ?? {}),
      params.now,
    ],
  );
}

function seedExpansionGraph(
  backend: SqliteLcmStorageBackend,
  params: { conversationId: string; now: number },
): void {
  insertConversation(backend, { conversationId: params.conversationId, now: params.now });
  insertMessage(backend, {
    conversationId: params.conversationId,
    messageId: "msg-leaf",
    ordinal: 1,
    role: "assistant",
    content: "Leaf evidence payload.",
    now: params.now + 1,
  });

  insertSummaryItem(backend, {
    conversationId: params.conversationId,
    itemId: "sum-root",
    title: "Root",
    body: "Root body",
    now: params.now + 2,
  });
  insertSummaryItem(backend, {
    conversationId: params.conversationId,
    itemId: "sum-a",
    title: "A",
    body: "Branch A",
    now: params.now + 3,
  });
  insertSummaryItem(backend, {
    conversationId: params.conversationId,
    itemId: "sum-b",
    title: "B",
    body: "Branch B",
    now: params.now + 4,
  });
  insertMessageItem(backend, {
    conversationId: params.conversationId,
    itemId: "item-msg-leaf",
    sourceMessageId: "msg-leaf",
    body: "Leaf pointer",
    now: params.now + 5,
  });

  insertEdge(backend, { parentId: "sum-root", childId: "sum-a", now: params.now + 6 });
  insertEdge(backend, { parentId: "sum-a", childId: "sum-b", now: params.now + 7 });
  insertEdge(backend, { parentId: "sum-b", childId: "item-msg-leaf", now: params.now + 8 });
}
