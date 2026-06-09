/** Mutates and persists isolated cron session state around one run. */
import fs from "node:fs";
import type { LiveSessionModelSelection } from "../../agents/live-model-switch.js";
import type { SessionEntry } from "../../config/sessions.js";
import { isCronSessionKey } from "../../sessions/session-key-utils.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { resolveCronSession } from "./session.js";

type MutableSessionStore = Record<string, SessionEntry>;

/** Mutable cron session entry updated by an isolated run before persistence. */
export type MutableCronSessionEntry = SessionEntry;
/** Resolved cron session plus its mutable backing store and active entry. */
export type MutableCronSession = ReturnType<typeof resolveCronSession> & {
  store: MutableSessionStore;
  sessionEntry: MutableCronSessionEntry;
};
/** Live provider/model/auth-profile selection reported by the running session. */
export type CronLiveSelection = LiveSessionModelSelection;

type PatchSessionEntry = (params: {
  storePath: string;
  sessionKey: string;
  fallbackEntry: SessionEntry;
  update: (entry: SessionEntry) => Partial<SessionEntry> | null;
  deleteFields?: readonly (keyof SessionEntry)[];
  preservePatchActivity?: boolean;
  skipMaintenance?: boolean;
}) => Promise<SessionEntry | null>;

/** Persists the currently selected mutable cron session entry to the session store. */
export type PersistCronSessionEntry = () => Promise<void>;

function cronTranscriptExists(entry: SessionEntry): boolean {
  const sessionFile = entry.sessionFile?.trim();
  return Boolean(sessionFile && fs.existsSync(sessionFile));
}

function normalizeSessionField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toNonResumableCronSessionEntry(entry: SessionEntry): SessionEntry {
  const next = { ...entry } as Partial<SessionEntry>;
  // If the transcript never materialized, do not persist stale resume handles
  // that would make the next cron run believe a resumable CLI session exists.
  delete next.sessionId;
  delete next.sessionFile;
  delete next.sessionStartedAt;
  delete next.lastInteractionAt;
  delete next.cliSessionIds;
  delete next.cliSessionBindings;
  delete next.claudeCliSessionId;
  return next as SessionEntry;
}

const NON_RESUMABLE_CRON_SESSION_FIELDS = [
  "sessionId",
  "sessionFile",
  "sessionStartedAt",
  "lastInteractionAt",
  "cliSessionIds",
  "cliSessionBindings",
  "claudeCliSessionId",
] as const satisfies ReadonlyArray<keyof SessionEntry>;

function reconcileActiveCronEntryAfterNonResumablePersist(params: {
  activeEntry: SessionEntry;
  persistedEntry: SessionEntry;
}): SessionEntry {
  const next = { ...params.persistedEntry };
  for (const field of NON_RESUMABLE_CRON_SESSION_FIELDS) {
    if (Object.hasOwn(params.activeEntry, field)) {
      next[field] = params.activeEntry[field] as never;
    }
  }
  return next;
}

function deriveCronSessionPatch(params: {
  persistedRow: SessionEntry | undefined;
  previousCronEntry: SessionEntry;
  nextCronEntry: SessionEntry;
}): Partial<SessionEntry> {
  if (!params.persistedRow) {
    return { ...params.nextCronEntry };
  }
  const patch: Partial<SessionEntry> = {};
  for (const key of Object.keys(params.nextCronEntry) as Array<keyof SessionEntry>) {
    if (JSON.stringify(params.persistedRow[key]) !== JSON.stringify(params.nextCronEntry[key])) {
      patch[key] = params.nextCronEntry[key] as never;
    }
  }
  for (const key of Object.keys(params.previousCronEntry) as Array<keyof SessionEntry>) {
    if (!Object.hasOwn(params.nextCronEntry, key)) {
      patch[key] = undefined as never;
    }
  }
  return patch;
}

/** Creates the persistence callback that stores cron session metadata after a run. */
export function createPersistCronSessionEntry(params: {
  isFastTestEnv: boolean;
  cronSession: MutableCronSession;
  agentSessionKey: string;
  patchSessionEntry: PatchSessionEntry;
}): PersistCronSessionEntry {
  const initialStoreEntry = params.cronSession.store[params.agentSessionKey];
  let lastPersistedRow = initialStoreEntry ? structuredClone(initialStoreEntry) : undefined;
  let lastCronOwnedEntry = initialStoreEntry
    ? structuredClone(initialStoreEntry)
    : structuredClone(params.cronSession.sessionEntry);
  return async () => {
    if (params.isFastTestEnv) {
      return;
    }
    const shouldDropResumeFields =
      isCronSessionKey(params.agentSessionKey) &&
      Boolean(params.cronSession.sessionEntry.sessionId) &&
      !cronTranscriptExists(params.cronSession.sessionEntry);
    const persistedEntry = shouldDropResumeFields
      ? toNonResumableCronSessionEntry(params.cronSession.sessionEntry)
      : params.cronSession.sessionEntry;

    const patch = deriveCronSessionPatch({
      persistedRow: lastPersistedRow,
      previousCronEntry: lastCronOwnedEntry,
      nextCronEntry: persistedEntry,
    });
    const deleteFields = shouldDropResumeFields ? NON_RESUMABLE_CRON_SESSION_FIELDS : undefined;
    for (const field of deleteFields ?? []) {
      Reflect.deleteProperty(patch, field);
    }
    if (typeof persistedEntry.updatedAt === "number" && Number.isFinite(persistedEntry.updatedAt)) {
      patch.updatedAt = persistedEntry.updatedAt;
    }
    const persisted = await params.patchSessionEntry({
      storePath: params.cronSession.storePath,
      sessionKey: params.agentSessionKey,
      fallbackEntry: persistedEntry,
      update: () => (Object.keys(patch).length > 0 || deleteFields ? patch : null),
      deleteFields,
      preservePatchActivity: true,
    });
    if (!persisted) {
      return;
    }
    if (shouldDropResumeFields) {
      params.cronSession.store[params.agentSessionKey] = persisted;
      params.cronSession.sessionEntry = reconcileActiveCronEntryAfterNonResumablePersist({
        activeEntry: params.cronSession.sessionEntry,
        persistedEntry: persisted,
      });
      lastPersistedRow = structuredClone(persisted);
      lastCronOwnedEntry = structuredClone(params.cronSession.sessionEntry);
      return;
    }
    // Update both in-memory handles so later operations in this process observe
    // the same reconciled row that hit disk.
    params.cronSession.sessionEntry = persisted;
    params.cronSession.store[params.agentSessionKey] = persisted;
    lastPersistedRow = structuredClone(persisted);
    lastCronOwnedEntry = structuredClone(persisted);
  };
}

/** Adopts the session id/file produced by a run and preserves usage-family lineage. */
export function adoptCronRunSessionMetadata(params: {
  entry: MutableCronSessionEntry;
  sessionKey: string;
  runMeta?: {
    sessionId?: string;
    sessionFile?: string;
  };
}): boolean {
  const nextSessionId = normalizeSessionField(params.runMeta?.sessionId);
  const nextSessionFile = normalizeSessionField(params.runMeta?.sessionFile);
  if (!nextSessionFile) {
    return false;
  }

  let changed = false;
  const previousSessionId = params.entry.sessionId;
  if (nextSessionId && nextSessionId !== previousSessionId) {
    params.entry.sessionId = nextSessionId;
    params.entry.usageFamilyKey = params.entry.usageFamilyKey ?? params.sessionKey;
    params.entry.usageFamilySessionIds = Array.from(
      new Set([
        ...(params.entry.usageFamilySessionIds ?? []),
        ...(previousSessionId ? [previousSessionId] : []),
        nextSessionId,
      ]),
    );
    changed = true;
  }

  if (nextSessionFile !== params.entry.sessionFile) {
    params.entry.sessionFile = nextSessionFile;
    changed = true;
  }

  return changed;
}

/** Persists a changed skills snapshot onto the cron session entry outside fast tests. */
export async function persistCronSkillsSnapshotIfChanged(params: {
  isFastTestEnv: boolean;
  cronSession: MutableCronSession;
  skillsSnapshot: SkillSnapshot;
  nowMs: number;
  persistSessionEntry: PersistCronSessionEntry;
}) {
  if (
    params.isFastTestEnv ||
    params.skillsSnapshot === params.cronSession.sessionEntry.skillsSnapshot
  ) {
    return;
  }
  params.cronSession.sessionEntry = {
    ...params.cronSession.sessionEntry,
    updatedAt: params.nowMs,
    skillsSnapshot: params.skillsSnapshot,
  };
  await params.persistSessionEntry();
}

/** Records the selected provider/model before a cron run starts. */
export function markCronSessionPreRun(params: {
  entry: MutableCronSessionEntry;
  provider: string;
  model: string;
}) {
  params.entry.modelProvider = params.provider;
  params.entry.model = params.model;
  params.entry.systemSent = true;
}

/** Syncs live model/auth-profile changes from a running cron session back to storage. */
export function syncCronSessionLiveSelection(params: {
  entry: MutableCronSessionEntry;
  liveSelection: CronLiveSelection;
}) {
  params.entry.modelProvider = params.liveSelection.provider;
  params.entry.model = params.liveSelection.model;
  if (params.liveSelection.authProfileId) {
    params.entry.authProfileOverride = params.liveSelection.authProfileId;
    params.entry.authProfileOverrideSource = params.liveSelection.authProfileIdSource;
    if (params.liveSelection.authProfileIdSource === "auto") {
      // Auto-selected profiles are tied to the compaction generation that
      // resolved them; manual overrides should survive later compactions.
      params.entry.authProfileOverrideCompactionCount = params.entry.compactionCount ?? 0;
    } else {
      delete params.entry.authProfileOverrideCompactionCount;
    }
    return;
  }
  delete params.entry.authProfileOverride;
  delete params.entry.authProfileOverrideSource;
  delete params.entry.authProfileOverrideCompactionCount;
}
