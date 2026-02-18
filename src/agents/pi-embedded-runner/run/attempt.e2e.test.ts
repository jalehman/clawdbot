import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { injectHistoryImagesIntoMessages, repairAssembledMessagesForLcm } from "./attempt.js";

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
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(Array.isArray(firstUser?.content)).toBe(true);
    const content = firstUser?.content as Array<{ type: string; text?: string; data?: string }>;
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
    const first = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
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
      } as unknown as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[1, [image]]]));

    expect(didMutate).toBe(false);
    const firstAssistant = messages[0] as Extract<AgentMessage, { role: "assistant" }> | undefined;
    expect(firstAssistant?.content).toBe("noop");
  });
});

describe("repairAssembledMessagesForLcm", () => {
  it("drops orphan tool results in LCM assembled history", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
      } as AgentMessage,
    ];

    const repaired = repairAssembledMessagesForLcm({
      messages,
      contextEngineId: "lcm",
      repairToolUseResultPairing: true,
    });

    expect(repaired).toHaveLength(0);
  });

  it("inserts synthetic tool results for unresolved assistant tool calls", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_2", name: "read", input: { path: "foo.txt" } }],
      } as AgentMessage,
    ];

    const repaired = repairAssembledMessagesForLcm({
      messages,
      contextEngineId: "lcm",
      repairToolUseResultPairing: true,
    });

    expect(repaired).toHaveLength(2);
    expect(repaired[0]?.role).toBe("assistant");
    expect(repaired[1]?.role).toBe("toolResult");
    expect((repaired[1] as { toolCallId?: string }).toolCallId).toBe("call_2");
  });

  it("is a no-op when context engine is not LCM", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_3",
        content: [{ type: "tool_result", tool_use_id: "call_3", content: "ok" }],
      } as AgentMessage,
    ];

    const repaired = repairAssembledMessagesForLcm({
      messages,
      contextEngineId: "legacy",
      repairToolUseResultPairing: true,
    });

    expect(repaired).toBe(messages);
  });
});
