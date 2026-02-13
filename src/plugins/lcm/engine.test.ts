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

/**
 * Normalize assembled message content into text for assertions.
 *
 * LCM reconstructs assistant turns as text blocks, so this helper accepts
 * either raw strings or content block arrays.
 */
function getMessageText(message: AgentMessage): string {
  if (!("content" in message)) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block): block is { type?: unknown; text?: unknown } => {
      return !!block && typeof block === "object";
    })
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

  it("roundtrip keeps stored and assembled assistant text as plain text", async () => {
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

    const assembled = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 2048,
    });

    expect(assembled.messages).toHaveLength(1);
    expect(getMessageText(assembled.messages[0])).toBe("HEARTBEAT_OK");
  });
});
