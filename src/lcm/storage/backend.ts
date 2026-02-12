import type { LcmStorageBackend, SqliteLcmStorageOptions } from "./types.js";
import { createSqliteLcmStorageBackend } from "./sqlite.js";

/**
 * Top-level storage backend configuration.
 */
export type LcmStorageBackendOptions = {
  sqlite: SqliteLcmStorageOptions;
};

/**
 * Create the LCM storage backend.
 *
 * V1 intentionally supports SQLite only.
 */
export function createLcmStorageBackend(options: LcmStorageBackendOptions): LcmStorageBackend {
  return createSqliteLcmStorageBackend(options.sqlite);
}
