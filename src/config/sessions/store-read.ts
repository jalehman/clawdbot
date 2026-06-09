// Read-only session store loading uses SQLite without creating or repairing state.
import { cloneSessionStoreRecord } from "./store-cache.js";
import { normalizeSessionStore } from "./store-load.js";
import { loadExistingSqliteSessionStoreReadOnly } from "./store-sqlite.js";
import type { SessionEntry } from "./types.js";

export type SessionStoreReadOnlyResult =
  | {
      ok: true;
      store: Record<string, SessionEntry>;
    }
  | {
      error: unknown;
      ok: false;
      store: Record<string, SessionEntry>;
    };

/** Reads a session store without mutating it and drops malformed entries. */
export function readSessionStoreReadOnly(
  storePath: string,
  opts?: { clone?: boolean },
): Record<string, SessionEntry> {
  return readSessionStoreReadOnlyResult(storePath, opts).store;
}

/** Reads a session store without mutating it and reports read failures separately. */
export function readSessionStoreReadOnlyResult(
  storePath: string,
  opts?: { clone?: boolean },
): SessionStoreReadOnlyResult {
  try {
    const store = loadExistingSqliteSessionStoreReadOnly(storePath);
    normalizeSessionStore(store);
    return {
      ok: true,
      store: opts?.clone === false ? store : cloneSessionStoreRecord(store),
    };
  } catch (error) {
    return { error, ok: false, store: {} };
  }
}
