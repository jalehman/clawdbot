import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";
import { compactSessionWithContextEngine } from "./compact.js";

describe("compactSessionWithContextEngine", () => {
  it("runs ingest -> assemble -> compact and applies assembled messages", async () => {
    const ingest = vi.fn<ContextEngine["ingest"]>(async () => ({
      messages: [{ role: "user", content: "normalized" } as AgentMessage],
      meta: { fromIngest: true },
    }));
    const assemble = vi.fn<ContextEngine["assemble"]>(async () => ({
      messages: [{ role: "user", content: "assembled" } as AgentMessage],
      meta: { fromAssemble: true },
    }));
    const compact = vi.fn<ContextEngine["compact"]>(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "done",
        firstKeptEntryId: "entry-1",
        tokensBefore: 1000,
        tokensAfter: 400,
      },
    }));
    const replaceMessages = vi.fn();
    const contextEngine: ContextEngine = {
      id: "test-engine",
      ingest,
      assemble,
      compact,
    };

    const result = await compactSessionWithContextEngine({
      contextEngine,
      messages: [{ role: "user", content: "raw" } as AgentMessage],
      provider: "anthropic",
      modelId: "claude-sonnet",
      sessionId: "session-1",
      historyTurnLimit: 6,
      customInstructions: "preserve decisions",
      replaceMessages,
      ingestMeta: { sessionManager: { mock: true } },
      assembleMeta: { sessionKey: "session-key" },
      compactMeta: { compactSession: { mock: true } },
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
        historyTurnLimit: 6,
      }),
    );
    expect(replaceMessages).toHaveBeenCalledWith([{ role: "user", content: "assembled" }]);
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        customInstructions: "preserve decisions",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      compacted: true,
      result: {
        summary: "done",
      },
    });
  });
});
