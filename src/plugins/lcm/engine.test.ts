import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LcmConfig } from "./db/config.js";
import { ContextAssembler } from "./assembler.js";
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

function createSessionFilePath(name: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), "openclaw-lcm-session-"));
  tempDirs.push(tempDir);
  return join(tempDir, `${name}.jsonl`);
}

function makeMessage(params: { role?: string; content: unknown }): AgentMessage {
  return {
    role: (params.role ?? "assistant") as AgentMessage["role"],
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

// ── Bootstrap ───────────────────────────────────────────────────────────────

describe("LcmContextEngine.bootstrap", () => {
  it("imports only active leaf-path messages from SessionManager context", async () => {
    const sessionFile = createSessionFilePath("branched");
    const sm = SessionManager.open(sessionFile);

    const rootUserId = sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "root user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "abandoned assistant" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "abandoned user" }],
    } as AgentMessage);

    // Re-branch from the first user entry so prior turns are abandoned.
    sm.branch(rootUserId);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "active assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-leaf-path";
    const result = await engine.bootstrap({ sessionId, sessionFile });

    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(conversation!.bootstrappedAt).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
    expect(stored.map((m) => m.content)).toEqual(["root user", "active assistant"]);

    const contextItems = await engine
      .getSummaryStore()
      .getContextItems(conversation!.conversationId);
    expect(contextItems).toHaveLength(2);
    expect(contextItems.every((item) => item.itemType === "message")).toBe(true);
  });

  it("is idempotent and does not duplicate already bootstrapped sessions", async () => {
    const sessionFile = createSessionFilePath("idempotent");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-idempotent";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    const second = await engine.bootstrap({ sessionId, sessionFile });

    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);
    expect(second.bootstrapped).toBe(false);
    expect(second.importedMessages).toBe(0);
    expect(second.reason).toBe("already bootstrapped");

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(await engine.getConversationStore().getMessageCount(conversation!.conversationId)).toBe(
      2,
    );
  });

  it("uses the bulk import path for initial bootstrap", async () => {
    const sessionFile = createSessionFilePath("bulk");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "bulk one" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "bulk two" }],
    } as AgentMessage);

    const engine = createEngine();
    const bulkSpy = vi.spyOn(engine.getConversationStore(), "createMessagesBulk");
    const singleSpy = vi.spyOn(engine.getConversationStore(), "createMessage");

    const result = await engine.bootstrap({
      sessionId: "bootstrap-bulk",
      sessionFile,
    });

    expect(result.bootstrapped).toBe(true);
    expect(bulkSpy).toHaveBeenCalledTimes(1);
    expect(singleSpy).not.toHaveBeenCalled();
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

describe("LcmContextEngine fidelity and token budget", () => {
  it("preserves structured toolResult content via message_parts and assembler", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const toolResult = {
      role: "toolResult",
      toolCallId: "call_123",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_123",
          content: [{ type: "text", text: "command output" }],
        },
      ],
    } as AgentMessage;

    await engine.ingest({
      sessionId,
      message: toolResult,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].role).toBe("tool");

    const parts = await engine.getConversationStore().getMessageParts(storedMessages[0].messageId);
    expect(parts).toHaveLength(1);
    expect(parts[0].partType).toBe("tool");
    expect(parts[0].toolCallId).toBe("call_123");

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });
    expect(assembled.messages).toHaveLength(1);

    const assembledMessage = assembled.messages[0] as {
      role: string;
      toolCallId?: string;
      content?: unknown;
    };
    expect(assembledMessage.role).toBe("toolResult");
    expect(assembledMessage.toolCallId).toBe("call_123");
    expect(Array.isArray(assembledMessage.content)).toBe(true);
    expect((assembledMessage.content as Array<{ type?: string }>)[0]?.type).toBe("tool_result");
  });

  it("maps unknown roles to assistant instead of silently coercing to user", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "custom-event", content: "opaque payload" }),
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].role).toBe("assistant");
  });

  it("uses explicit compact tokenBudget over legacy tokenBudget", async () => {
    const engine = createEngine();
    const evaluateSpy = vi.spyOn((engine as any).compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 12,
      threshold: 9,
    });
    const compactSpy = vi.spyOn((engine as any).compaction, "compactUntilUnder");

    await engine.ingest({
      sessionId: "budget-session",
      message: makeMessage({ role: "user", content: "hello world" }),
    });

    const result = await engine.compact({
      sessionId: "budget-session",
      sessionFile: "/tmp/unused.jsonl",
      tokenBudget: 123,
      legacyParams: { tokenBudget: 999 },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 123);
    expect(compactSpy).not.toHaveBeenCalled();
  });
});
