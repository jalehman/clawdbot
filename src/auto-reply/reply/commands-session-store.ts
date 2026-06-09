// Shared session-store helpers for command handlers that mutate sessions.
import type { SessionEntry } from "../../config/sessions.js";
import { patchSessionEntryWithRowOptions } from "../../config/sessions.js";
import { applyAbortCutoffToSessionEntry, type AbortCutoff } from "./abort-cutoff.js";
import type { CommandHandler } from "./commands-types.js";

type CommandParams = Parameters<CommandHandler>[0];

export async function persistSessionEntry(params: CommandParams): Promise<boolean> {
  if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) {
    return false;
  }
  const sessionEntry = params.sessionEntry;
  const sessionKey = params.sessionKey;
  sessionEntry.updatedAt = Date.now();
  params.sessionStore[sessionKey] = sessionEntry;
  if (params.storePath) {
    // Slash commands mutate one known session entry; skipping global session
    // maintenance avoids scanning the whole sessions directory for simple
    // command-only writes.
    const persisted = await patchSessionEntryWithRowOptions({
      storePath: params.storePath,
      sessionKey,
      fallbackEntry: sessionEntry,
      update: () => sessionEntry,
      skipMaintenance: true,
    });
    if (persisted) {
      params.sessionStore[sessionKey] = persisted;
    }
  }
  return true;
}

export async function persistAbortTargetEntry(params: {
  entry?: SessionEntry;
  key?: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  abortCutoff?: AbortCutoff;
}): Promise<boolean> {
  const { entry, key, sessionStore, storePath, abortCutoff } = params;
  if (!entry || !key || !sessionStore) {
    return false;
  }

  entry.abortedLastRun = true;
  applyAbortCutoffToSessionEntry(entry, abortCutoff);
  entry.updatedAt = Date.now();
  sessionStore[key] = entry;

  if (storePath) {
    const patch: Partial<SessionEntry> = {
      abortedLastRun: true,
      abortCutoffMessageSid: abortCutoff?.messageSid,
      abortCutoffTimestamp: abortCutoff?.timestamp,
      updatedAt: entry.updatedAt,
    };
    const persisted = await patchSessionEntryWithRowOptions({
      storePath,
      sessionKey: key,
      fallbackEntry: entry,
      update: () => patch,
    });
    if (persisted) {
      sessionStore[key] = persisted;
    }
  }

  return true;
}
