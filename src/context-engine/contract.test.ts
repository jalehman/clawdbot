import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { ContextEngine } from "./types.js";

const minimalEngine = {
  id: "minimal-test-engine",
  ingest: async (params) => ({
    messages: params.messages,
    meta: {
      ...params.meta,
      ingestSeen: true,
    },
  }),
  assemble: async (params) => ({
    messages: params.messages,
    meta: {
      ...params.meta,
      assembleSeen: true,
    },
  }),
  compact: async (params) => ({
    ok: true,
    compacted: false,
    reason: `messages=${params.messages.length}`,
  }),
} satisfies ContextEngine;

describe("ContextEngine contract", () => {
  it("supports a minimal implementation across ingest, assemble, and compact", async () => {
    const messages: AgentMessage[] = [{ role: "user", content: "hello" }];

    const ingested = await minimalEngine.ingest({
      messages,
      provider: "anthropic",
      modelId: "claude-sonnet",
      sessionId: "session-1",
      meta: { source: "test" },
    });

    const assembled = await minimalEngine.assemble({
      messages: ingested.messages,
      historyTurnLimit: 5,
      meta: ingested.meta,
    });

    const compacted = await minimalEngine.compact({
      messages: assembled.messages,
      customInstructions: "none",
      meta: assembled.meta,
    });

    expect(ingested.messages).toEqual(messages);
    expect(assembled.messages).toEqual(messages);
    expect(assembled.meta).toMatchObject({
      source: "test",
      ingestSeen: true,
      assembleSeen: true,
    });
    expect(compacted).toEqual({
      ok: true,
      compacted: false,
      reason: "messages=1",
    });
  });
});
