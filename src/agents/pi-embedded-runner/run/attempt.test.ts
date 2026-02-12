import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../../context-engine/types.js";
import {
  assembleSessionHistoryWithContextEngine,
  injectHistoryImagesIntoMessages,
} from "./attempt.js";

describe("injectHistoryImagesIntoMessages", () => {
  const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };

  it("injects history images and converts string content", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "See /tmp/photo.png",
      } as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[0, [image]]]));

    expect(didMutate).toBe(true);
    expect(Array.isArray(messages[0]?.content)).toBe(true);
    const content = messages[0]?.content as Array<{ type: string; text?: string; data?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe("text");
    expect(content[1]).toMatchObject({ type: "image", data: "abc" });
  });

  it("avoids duplicating existing image content", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      } as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[0, [image]]]));

    expect(didMutate).toBe(false);
    const first = messages[0];
    if (!first || !Array.isArray(first.content)) {
      throw new Error("expected array content");
    }
    expect(first.content).toHaveLength(2);
  });

  it("ignores non-user messages and out-of-range indices", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: "noop",
      } as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[1, [image]]]));

    expect(didMutate).toBe(false);
    expect(messages[0]?.content).toBe("noop");
  });
});

describe("assembleSessionHistoryWithContextEngine", () => {
  it("routes ingest/assemble through the selected engine with history limits", async () => {
    const ingest = vi.fn<ContextEngine["ingest"]>(async () => ({
      messages: [{ role: "user", content: "normalized" } as AgentMessage],
      meta: { fromIngest: true },
    }));
    const assemble = vi.fn<ContextEngine["assemble"]>(async () => ({
      messages: [{ role: "user", content: "assembled" } as AgentMessage],
      meta: { fromAssemble: true },
    }));
    const contextEngine: ContextEngine = {
      id: "test-engine",
      ingest,
      assemble,
      compact: async () => ({ ok: true, compacted: false }),
    };

    const result = await assembleSessionHistoryWithContextEngine({
      contextEngine,
      messages: [{ role: "user", content: "raw" } as AgentMessage],
      provider: "anthropic",
      modelId: "claude-sonnet",
      sessionId: "session-1",
      historyTurnLimit: 7,
      ingestMeta: { sessionManager: { mock: true } },
      assembleMeta: { sessionKey: "session-key" },
    });

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        modelId: "claude-sonnet",
        sessionId: "session-1",
      }),
    );
    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        historyTurnLimit: 7,
        meta: {
          fromIngest: true,
          sessionKey: "session-key",
        },
      }),
    );
    expect(result).toEqual([{ role: "user", content: "assembled" }]);
  });
});
