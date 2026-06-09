// Tests CLI dispatch arguments and runtime selection for agent runner turns.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
  type SessionEntry,
} from "../../config/sessions.js";
import {
  clearDroppedCliSessionBinding,
  keepCliSessionBindingOnlyWhenReused,
} from "./agent-runner-cli-dispatch.js";

describe("keepCliSessionBindingOnlyWhenReused", () => {
  it("keeps the first room-event CLI binding when no binding exists yet", () => {
    const result = {
      payloads: [],
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "new-cli-session",
          provider: "claude-cli",
          model: "claude-opus-4-8",
          cliSessionBinding: {
            sessionId: "new-cli-session",
            authProfileId: "profile",
          },
        },
      },
    } satisfies EmbeddedAgentRunResult;

    expect(keepCliSessionBindingOnlyWhenReused({ result })).toBe(result);
  });

  it("drops a replacement room-event CLI binding when an existing binding was reused", () => {
    const onDroppedReplacement = vi.fn();
    const result = keepCliSessionBindingOnlyWhenReused({
      existingSessionId: "existing-cli-session",
      onDroppedReplacement,
      result: {
        payloads: [],
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "replacement-cli-session",
            provider: "claude-cli",
            model: "claude-opus-4-8",
            cliSessionBinding: {
              sessionId: "replacement-cli-session",
              authProfileId: "profile",
            },
          },
        },
      } satisfies EmbeddedAgentRunResult,
    });

    expect(onDroppedReplacement).toHaveBeenCalledOnce();
    expect(result.meta.agentMeta?.sessionId).toBe("");
    expect(result.meta.agentMeta?.cliSessionBinding).toBeUndefined();
  });
});

describe("clearDroppedCliSessionBinding", () => {
  it("clears the dropped CLI binding from one persisted session entry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-dispatch-"));
    try {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:explicit:cli-dispatch";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: 1,
          claudeCliSessionId: "claude-session",
          cliSessionIds: {
            "claude-cli": "claude-session",
            codex: "codex-session",
          },
        },
      };
      await saveSessionStore(storePath, sessionStore, { skipMaintenance: true });

      await clearDroppedCliSessionBinding({
        provider: "claude-cli",
        sessionKey,
        sessionStore,
        storePath,
      });

      const persisted = loadSessionStore(storePath, { skipCache: true });
      expect(persisted[sessionKey]?.claudeCliSessionId).toBeUndefined();
      expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
      expect(persisted[sessionKey]?.cliSessionIds?.codex).toBe("codex-session");
    } finally {
      clearSessionStoreCacheForTest();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
