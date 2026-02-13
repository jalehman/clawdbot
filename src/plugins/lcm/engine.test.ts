import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LcmConfig } from "./db/config.js";
import { closeLcmConnection } from "./db/connection.js";
import { LcmContextEngine } from "./engine.js";

const tempDirs: string[] = [];

function createTestConfig(databasePath: string): LcmConfig {
  return {
    enabled: true,
    databasePath,
    contextThreshold: 0.75,
    freshTailCount: 8,
    leafTargetTokens: 600,
    condensedTargetTokens: 900,
    maxExpandTokens: 4000,
    autocompactDisabled: false,
  };
}

function createEngine(): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "openclaw-lcm-engine-"));
  tempDirs.push(tempDir);
  return new LcmContextEngine(createTestConfig(join(tempDir, "lcm.db")));
}

function makeMessage(params: { role?: "user" | "assistant"; content: unknown }): AgentMessage {
  return {
    role: params.role ?? "assistant",
    content: params.content,
    timestamp: Date.now(),
  } as AgentMessage;
}

async function ingestAndReadStoredContent(params: {
  engine: LcmContextEngine;
  sessionId: string;
  message: AgentMessage;
}): Promise<string> {
  await params.engine.ingest({
    sessionId: params.sessionId,
    message: params.message,
  });

  const conversation = await params.engine
    .getConversationStore()
    .getConversationBySessionId(params.sessionId);
  expect(conversation).not.toBeNull();

  const messages = await params.engine
    .getConversationStore()
    .getMessages(conversation!.conversationId);
  expect(messages).toHaveLength(1);

  return messages[0].content;
}

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Ingest content extraction ───────────────────────────────────────────────

describe("LcmContextEngine.ingest content extraction", () => {
  it("stores string content as-is", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({ role: "user", content: "hello world" }),
    });

    expect(content).toBe("hello world");
  });

  it("flattens text content block arrays to plain text", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({
        content: [{ type: "text", text: "hello" }],
      }),
    });

    expect(content).toBe("hello");
  });

  it("extracts only text blocks from mixed content arrays", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({
        content: [
          { type: "text", text: "line one" },
          { type: "thinking", thinking: "internal chain of thought" },
          { type: "tool_use", name: "bash" },
          { type: "text", text: "line two" },
        ],
      }),
    });

    expect(content).toBe("line one\nline two");
  });

  it("stores empty string for empty content arrays", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({ content: [] }),
    });

    expect(content).toBe("");
  });

  it("falls back to JSON.stringify for non-array, non-string content", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({ content: { status: "ok", count: 2 } }),
    });

    expect(content).toBe('{"status":"ok","count":2}');
  });

  it("roundtrip stores plain text, not JSON content blocks", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    await engine.ingest({
      sessionId,
      message: makeMessage({
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      }),
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].content).toBe("HEARTBEAT_OK");
    expect(storedMessages[0].content).not.toContain('{"type":"text"');
  });
});

// ── Assemble pass-through ───────────────────────────────────────────────────

describe("LcmContextEngine.assemble pass-through", () => {
  it("returns the same message array reference", async () => {
    const engine = createEngine();
    const liveMessages: AgentMessage[] = [
      { role: "user", content: "first turn" },
      { role: "assistant", content: "first reply" },
    ] as AgentMessage[];

    const result = await engine.assemble({
      sessionId: "session-identity",
      messages: liveMessages,
      tokenBudget: 100,
    });

    expect(result.messages).toBe(liveMessages);
    expect(result.estimatedTokens).toBe(0);
  });

  it("does not modify or reorder live messages", async () => {
    const engine = createEngine();
    const liveMessages: AgentMessage[] = [
      { role: "user", content: "system bootstrap context" },
      { role: "assistant", content: "assistant setup response" },
      { role: "user", content: "current user turn" },
    ] as AgentMessage[];
    const before = liveMessages.map((message) => ({ ...message }));

    const result = await engine.assemble({
      sessionId: "session-order",
      messages: liveMessages,
    });

    expect(result.messages).toBe(liveMessages);
    expect(result.messages).toEqual(before);
  });

  it("passes through even when a conversation exists in the DB", async () => {
    const engine = createEngine();
    const sessionId = "session-with-conversation";
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "persisted message" } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const liveMessages: AgentMessage[] = [
      { role: "assistant", content: "pre-prompt boot message" },
      { role: "user", content: "latest prompt message" },
    ] as AgentMessage[];

    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 32,
    });

    expect(result.messages).toBe(liveMessages);
    expect(result.estimatedTokens).toBe(0);
  });

  it("keeps live messages unchanged after ingest plus assemble roundtrip", async () => {
    const engine = createEngine();
    const sessionId = "session-roundtrip";
    const liveMessages: AgentMessage[] = [
      { role: "user", content: "bootstrap context" },
      { role: "assistant", content: "assistant guidance" },
      { role: "user", content: "next question" },
    ] as AgentMessage[];
    const before = liveMessages.map((message) => ({ ...message }));

    for (const message of liveMessages) {
      await engine.ingest({ sessionId, message });
    }

    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
    });

    expect(result.messages).toBe(liveMessages);
    expect(result.messages).toEqual(before);
  });

  it("continues populating DB via ingest while assemble remains pass-through", async () => {
    const engine = createEngine();
    const sessionId = "session-ingest-db";
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "message one" } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "message two" } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const conversationId = conversation!.conversationId;

    expect(await engine.getConversationStore().getMessageCount(conversationId)).toBe(2);
    const contextItems = await engine.getSummaryStore().getContextItems(conversationId);
    expect(contextItems).toHaveLength(2);
    expect(contextItems.every((item) => item.itemType === "message")).toBe(true);

    const liveMessages: AgentMessage[] = [
      { role: "user", content: "latest live turn" },
    ] as AgentMessage[];
    const assembleResult = await engine.assemble({
      sessionId,
      messages: liveMessages,
    });
    expect(assembleResult.messages).toBe(liveMessages);

    expect(await engine.getConversationStore().getMessageCount(conversationId)).toBe(2);
    expect((await engine.getSummaryStore().getContextItems(conversationId)).length).toBe(2);
  });
});
