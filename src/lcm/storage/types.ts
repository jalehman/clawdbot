/**
 * Values supported by SQLite bound parameters.
 */
export type LcmSqlValue = string | number | bigint | Uint8Array | null;

/**
 * Positional SQL parameters.
 */
export type LcmSqlParams = ReadonlyArray<LcmSqlValue>;

/**
 * Transaction begin mode.
 */
export type LcmTransactionMode = "deferred" | "immediate" | "exclusive";

/**
 * Transaction behavior knobs.
 */
export type LcmTransactionOptions = {
  mode?: LcmTransactionMode;
  retries?: number;
};

/**
 * Minimal query surface exposed to callers and transaction scopes.
 */
export type LcmStorageConnection = {
  execute(sql: string, params?: LcmSqlParams): void;
  get<T>(sql: string, params?: LcmSqlParams): T | undefined;
  all<T>(sql: string, params?: LcmSqlParams): T[];
};

/**
 * Common storage backend contract for LCM persistence.
 */
export type LcmStorageBackend = LcmStorageConnection & {
  readonly dialect: "sqlite";
  readonly dbPath: string;
  readonly ftsEnabled: boolean;
  readonly ftsAvailable: boolean;
  migrate(): Promise<void>;
  withTransaction<T>(
    fn: (tx: LcmStorageConnection) => Promise<T> | T,
    options?: LcmTransactionOptions,
  ): Promise<T>;
  close(): Promise<void>;
};

/**
 * Individual schema migration.
 */
export type LcmSchemaMigration = {
  version: number;
  name: string;
  statements: ReadonlyArray<string>;
};

/**
 * SQLite runtime configuration for the LCM backend.
 */
export type SqliteLcmStorageOptions = {
  dbPath: string;
  busyTimeoutMs?: number;
  maxBusyRetries?: number;
  busyRetryDelayMs?: number;
  walMode?: boolean;
  synchronous?: "full" | "normal" | "off";
  enableFts?: boolean;
};
