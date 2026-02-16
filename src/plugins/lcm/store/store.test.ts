import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLcmConnection, closeLcmConnection } from "../db/connection.js";
import { runLcmMigrations } from "../db/migration.js";
import { ConversationStore } from "./conversation-store.js";
import { SummaryStore } from "./summary-store.js";

const tempDirs: string[] = [];
const dbPaths: string[] = [];

function createDbPath(prefix: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "lcm.db");
  dbPaths.push(dbPath);
  return dbPath;
}

function createStores(): {
  db: DatabaseSync;
  conversationStore: ConversationStore;
  summaryStore: SummaryStore;
} {
  const dbPath = createDbPath("openclaw-lcm-store-");
  const db = getLcmConnection(dbPath);
  runLcmMigrations(db);
  return {
    db,
    conversationStore: new ConversationStore(db),
    summaryStore: new SummaryStore(db),
  };
}

afterEach(() => {
  for (const dbPath of dbPaths.splice(0)) {
    closeLcmConnection(dbPath);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("lcm migration", () => {
  it("adds agent_id and backfills legacy conversation rows", () => {
    const dbPath = createDbPath("openclaw-lcm-migration-legacy-");
    const db = getLcmConnection(dbPath);

    db.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO conversations (session_id, title) VALUES ('session-a', 'A');
      INSERT INTO conversations (session_id, title) VALUES ('session-b', 'B');
    `);

    runLcmMigrations(db);

    const columns = db.prepare(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "agent_id")).toBe(true);

    const rows = db
      .prepare(`SELECT session_id, agent_id FROM conversations ORDER BY conversation_id`)
      .all() as Array<{
      session_id: string;
      agent_id: string;
    }>;
    expect(rows).toEqual([
      { session_id: "session-a", agent_id: "unknown" },
      { session_id: "session-b", agent_id: "unknown" },
    ]);

    const index = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'conversations_agent_created_idx'`,
      )
      .get() as { name: string } | undefined;
    expect(index?.name).toBe("conversations_agent_created_idx");
  });

  it("uses session-to-agent mapping when rerunning on partially populated data", () => {
    const dbPath = createDbPath("openclaw-lcm-migration-map-");
    const db = getLcmConnection(dbPath);

    db.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO conversations (session_id, title) VALUES ('session-map', 'source');
    `);
    runLcmMigrations(db);

    db.exec(`
      UPDATE conversations SET agent_id = 'agent-map' WHERE session_id = 'session-map';
      INSERT INTO conversations (session_id, title, agent_id)
      VALUES ('session-map', 'target', NULL);
    `);
    runLcmMigrations(db);

    const row = db
      .prepare(`SELECT agent_id FROM conversations WHERE title = 'target' LIMIT 1`)
      .get() as { agent_id: string } | undefined;
    expect(row?.agent_id).toBe("agent-map");
  });
});

describe("lcm conversation store", () => {
  it("stores agent ids and finds the most recent conversation by agent", async () => {
    const { db, conversationStore } = createStores();

    const seeded = await conversationStore.getOrCreateConversation("seed-session", "agent-seed");
    const seededAgain = await conversationStore.getOrCreateConversation(
      "seed-session",
      "agent-other",
    );
    expect(seededAgain.conversationId).toBe(seeded.conversationId);
    expect(seededAgain.agentId).toBe("agent-seed");

    const older = await conversationStore.createConversation({
      sessionId: "session-older",
      agentId: "agent-a",
    });
    const newer = await conversationStore.createConversation({
      sessionId: "session-newer",
      agentId: "agent-a",
    });
    await conversationStore.createConversation({
      sessionId: "session-other",
      agentId: "agent-b",
    });

    db.prepare(
      `UPDATE conversations SET created_at = ?, updated_at = ? WHERE conversation_id = ?`,
    ).run("2026-01-01 00:00:00", "2026-01-01 00:00:00", older.conversationId);
    db.prepare(
      `UPDATE conversations SET created_at = ?, updated_at = ? WHERE conversation_id = ?`,
    ).run("2026-01-01 00:10:00", "2026-01-01 00:10:00", newer.conversationId);

    const mostRecent = await conversationStore.getMostRecentConversationByAgent("agent-a");
    expect(mostRecent?.conversationId).toBe(newer.conversationId);

    const previous = await conversationStore.getMostRecentConversationByAgent(
      "agent-a",
      newer.conversationId,
    );
    expect(previous?.conversationId).toBe(older.conversationId);

    await expect(
      conversationStore.getMostRecentConversationByAgent("agent-missing"),
    ).resolves.toBeNull();
  });
});

describe("lcm summary store", () => {
  it("returns ordered context summary ids and supports bulk summary append", async () => {
    const { conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "summary-session",
      agentId: "summary-agent",
    });

    const message = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: "hello",
      tokenCount: 1,
    });

    await summaryStore.insertSummary({
      summaryId: "sum_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "A",
      tokenCount: 1,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_b",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "B",
      tokenCount: 1,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_c",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: "C",
      tokenCount: 1,
    });

    await summaryStore.appendContextMessage(conversation.conversationId, message.messageId);
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_a");
    await summaryStore.appendContextSummaries(conversation.conversationId, ["sum_b", "sum_c"]);
    await summaryStore.appendContextSummaries(conversation.conversationId, []);

    const summaryIds = await summaryStore.getContextSummaryIds(conversation.conversationId);
    expect(summaryIds).toEqual(["sum_a", "sum_b", "sum_c"]);
  });
});
