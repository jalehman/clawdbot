// Run session state tests cover persisted session state for isolated cron agents.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions.js";
import {
  adoptCronRunSessionMetadata,
  createPersistCronSessionEntry,
  type MutableCronSession,
} from "./run-session-state.js";

function makeSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "run-session-id",
    updatedAt: 1000,
    systemSent: true,
    ...overrides,
  };
}

function makeCronSession(entry = makeSessionEntry()): MutableCronSession {
  return {
    storePath: "/tmp/sessions.json",
    store: {},
    sessionEntry: entry,
    systemSent: true,
    isNewSession: true,
    previousSessionId: undefined,
  } as MutableCronSession;
}

function createPatchSessionEntryMock(initialStore: Record<string, SessionEntry> = {}) {
  const store: Record<string, SessionEntry> = { ...initialStore };
  const patchSessionEntry = vi.fn(
    async (params: {
      sessionKey: string;
      fallbackEntry: SessionEntry;
      update: (entry: SessionEntry) => Partial<SessionEntry> | null;
      deleteFields?: readonly string[];
      preservePatchActivity?: boolean;
    }) => {
      const existing = store[params.sessionKey] ?? params.fallbackEntry;
      const patch = params.update({ ...existing });
      if (!patch) {
        return existing;
      }
      const next = mergeSessionEntry(existing, patch);
      if (
        params.preservePatchActivity &&
        typeof patch.updatedAt === "number" &&
        Number.isFinite(patch.updatedAt)
      ) {
        next.updatedAt = Math.max(existing.updatedAt ?? 0, patch.updatedAt);
      }
      for (const field of params.deleteFields ?? []) {
        if (!Object.hasOwn(patch, field)) {
          Reflect.deleteProperty(next, field);
        }
      }
      const persisted = JSON.parse(JSON.stringify(next)) as SessionEntry;
      store[params.sessionKey] = persisted;
      return persisted;
    },
  );
  return { patchSessionEntry, store };
}

describe("createPersistCronSessionEntry", () => {
  it("persists isolated cron state only under the stable cron session key", async () => {
    const cronSession = makeCronSession(
      makeSessionEntry({
        sessionFile: await createTranscriptFile(),
        status: "running",
        startedAt: 900,
        skillsSnapshot: {
          prompt: "old prompt",
          skills: [{ name: "memory" }],
        },
      }),
    );
    const { patchSessionEntry, store } = createPatchSessionEntryMock();

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:job",
      patchSessionEntry,
    });

    await persist();

    expect(patchSessionEntry).toHaveBeenCalledOnce();
    expect(store["agent:main:cron:job"]).toBe(cronSession.sessionEntry);
    expect(store["agent:main:cron:job:run:run-session-id"]).toBeUndefined();
    expect(cronSession.store["agent:main:cron:job"]).toBe(cronSession.sessionEntry);
    expect(cronSession.store["agent:main:cron:job:run:run-session-id"]).toBeUndefined();
  });

  it("does not register cron sessions as resumable until the transcript exists", async () => {
    const missingTranscriptPath = path.join(
      os.tmpdir(),
      `openclaw-missing-cron-${crypto.randomUUID()}.jsonl`,
    );
    const cronSession = makeCronSession(
      makeSessionEntry({
        sessionFile: missingTranscriptPath,
        label: "Cron: shell-only",
        status: "running",
      }),
    );
    cronSession.store["agent:main:cron:shell-only"] = makeSessionEntry({
      sessionFile: missingTranscriptPath,
      groupActivation: "always",
    });
    const { patchSessionEntry, store } = createPatchSessionEntryMock({
      "agent:main:cron:shell-only": cronSession.store["agent:main:cron:shell-only"],
    });

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:shell-only",
      patchSessionEntry,
    });

    await persist();

    expect(store["agent:main:cron:shell-only"]).toEqual({
      label: "Cron: shell-only",
      status: "running",
      updatedAt: 1000,
      systemSent: true,
    });
    expect(cronSession.sessionEntry.sessionId).toBe("run-session-id");
    expect(cronSession.sessionEntry.sessionFile).toBe(missingTranscriptPath);
    expect(cronSession.sessionEntry.groupActivation).toBeUndefined();
    expect(cronSession.store["agent:main:cron:shell-only"]?.sessionId).toBeUndefined();
    expect(cronSession.store["agent:main:cron:shell-only"]?.sessionFile).toBeUndefined();

    cronSession.sessionEntry.status = "still-running";
    await persist();

    expect(store["agent:main:cron:shell-only"]).toMatchObject({
      status: "still-running",
    });
    expect(store["agent:main:cron:shell-only"]?.groupActivation).toBeUndefined();
  });

  it("restores resumable cron fields once the transcript exists", async () => {
    const transcriptPath = await createTranscriptFile();
    const cronSession = makeCronSession(
      makeSessionEntry({
        sessionFile: transcriptPath,
        label: "Cron: completed",
      }),
    );

    const { patchSessionEntry, store } = createPatchSessionEntryMock();
    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:completed",
      patchSessionEntry,
    });

    await persist();

    expect(store["agent:main:cron:completed"]).toEqual({
      sessionId: "run-session-id",
      sessionFile: transcriptPath,
      label: "Cron: completed",
      updatedAt: 1000,
      systemSent: true,
    });
    expect(cronSession.store["agent:main:cron:completed"]).toEqual({
      sessionId: "run-session-id",
      sessionFile: transcriptPath,
      label: "Cron: completed",
      updatedAt: 1000,
      systemSent: true,
    });
  });

  it("persists explicit session-bound cron state under the requested session key", async () => {
    const cronSession = makeCronSession();
    const { patchSessionEntry, store } = createPatchSessionEntryMock();

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:session",
      patchSessionEntry,
    });

    await persist();

    expect(store["agent:main:session"]).toBe(cronSession.sessionEntry);
    expect(cronSession.store["agent:main:session"]).toBe(cronSession.sessionEntry);
  });

  it("adopts rotated run transcript metadata before persisting session-bound cron state", async () => {
    const cronSession = makeCronSession(
      makeSessionEntry({
        sessionId: "bound-session",
        sessionFile: "/tmp/bound-session.jsonl",
      }),
    );
    const changed = adoptCronRunSessionMetadata({
      entry: cronSession.sessionEntry,
      sessionKey: "agent:main:telegram:direct:42",
      runMeta: {
        sessionId: "bound-session-rotated",
        sessionFile: "/tmp/bound-session-rotated.jsonl",
      },
    });
    const { patchSessionEntry, store } = createPatchSessionEntryMock();

    expect(changed).toBe(true);
    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:telegram:direct:42",
      patchSessionEntry,
    });

    await persist();

    expect(store["agent:main:telegram:direct:42"]).toEqual({
      sessionId: "bound-session-rotated",
      sessionFile: "/tmp/bound-session-rotated.jsonl",
      usageFamilyKey: "agent:main:telegram:direct:42",
      usageFamilySessionIds: ["bound-session", "bound-session-rotated"],
      updatedAt: 1000,
      systemSent: true,
    });
    expect(cronSession.store["agent:main:telegram:direct:42"]).toEqual({
      sessionId: "bound-session-rotated",
      sessionFile: "/tmp/bound-session-rotated.jsonl",
      usageFamilyKey: "agent:main:telegram:direct:42",
      usageFamilySessionIds: ["bound-session", "bound-session-rotated"],
      updatedAt: 1000,
      systemSent: true,
    });
  });

  it("preserves fresh row fields that cron did not change", async () => {
    const key = "agent:main:session";
    const baselineEntry = makeSessionEntry({ status: "queued" });
    const cronSession = makeCronSession({ ...baselineEntry });
    cronSession.store[key] = baselineEntry;
    cronSession.sessionEntry.status = "running";
    const { patchSessionEntry, store } = createPatchSessionEntryMock({
      [key]: {
        ...baselineEntry,
        groupActivation: "always",
      },
    });

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: key,
      patchSessionEntry,
    });

    await persist();

    expect(store[key]).toMatchObject({
      status: "running",
      groupActivation: "always",
    });
    expect(cronSession.sessionEntry.groupActivation).toBe("always");
  });
});

async function createTranscriptFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-session-"));
  const file = path.join(dir, "session.jsonl");
  await fs.writeFile(file, `${JSON.stringify({ type: "session", sessionId: "run-session-id" })}\n`);
  return file;
}
