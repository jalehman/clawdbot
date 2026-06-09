// Covers command-handler session persistence helpers.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
  type SessionEntry,
} from "../../config/sessions.js";
import { persistAbortTargetEntry, persistSessionEntry } from "./commands-session-store.js";
import type { HandleCommandsParams } from "./commands-types.js";

async function withTempStore<T>(run: (params: { storePath: string }) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-command-session-store-"));
  try {
    return await run({ storePath: path.join(dir, "sessions.json") });
  } finally {
    clearSessionStoreCacheForTest();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("persistSessionEntry", () => {
  it("patches one command session row while preserving fresh persisted fields", async () => {
    await withTempStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:command-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: 1,
          model: "gpt-5.5",
        },
      };
      await saveSessionStore(
        storePath,
        {
          [sessionKey]: {
            sessionId: "session-1",
            updatedAt: 1,
            groupActivation: "always",
          },
        },
        { skipMaintenance: true },
      );

      const persisted = await persistSessionEntry({
        sessionEntry: sessionStore[sessionKey],
        sessionKey,
        sessionStore,
        storePath,
      } as HandleCommandsParams);

      expect(persisted).toBe(true);
      const stored = loadSessionStore(storePath, { skipCache: true });
      expect(stored[sessionKey]).toMatchObject({
        sessionId: "session-1",
        model: "gpt-5.5",
        groupActivation: "always",
      });
      expect(sessionStore[sessionKey]).toMatchObject({
        model: "gpt-5.5",
        groupActivation: "always",
      });
    });
  });
});

describe("persistAbortTargetEntry", () => {
  it("clears abort cutoff fields through the row-scoped patch", async () => {
    await withTempStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:abort-target";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId: "session-1",
          updatedAt: 1,
          abortCutoffMessageSid: "old-message",
          abortCutoffTimestamp: 123,
        },
      };
      await saveSessionStore(storePath, sessionStore, { skipMaintenance: true });

      const persisted = await persistAbortTargetEntry({
        entry: sessionStore[sessionKey],
        key: sessionKey,
        sessionStore,
        storePath,
      });

      expect(persisted).toBe(true);
      const stored = loadSessionStore(storePath, { skipCache: true });
      expect(stored[sessionKey]).toMatchObject({
        sessionId: "session-1",
        abortedLastRun: true,
      });
      expect(stored[sessionKey]).not.toHaveProperty("abortCutoffMessageSid");
      expect(stored[sessionKey]).not.toHaveProperty("abortCutoffTimestamp");
      expect(sessionStore[sessionKey]).not.toHaveProperty("abortCutoffMessageSid");
      expect(sessionStore[sessionKey]).not.toHaveProperty("abortCutoffTimestamp");
    });
  });
});
