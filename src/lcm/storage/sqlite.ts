import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  LcmSchemaMigration,
  LcmSqlParams,
  LcmStorageBackend,
  LcmStorageConnection,
  LcmTransactionMode,
  LcmTransactionOptions,
  SqliteLcmStorageOptions,
} from "./types.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { LCM_FTS_STATEMENTS, LCM_SCHEMA_MIGRATIONS } from "./schema.js";

const SQLITE_MIGRATIONS_TABLE = "lcm_schema_migrations";
const DEFAULT_BUSY_TIMEOUT_MS = 2_500;
const DEFAULT_MAX_BUSY_RETRIES = 6;
const DEFAULT_BUSY_RETRY_DELAY_MS = 20;

/**
 * SQLite-backed LCM storage implementation.
 */
export class SqliteLcmStorageBackend implements LcmStorageBackend {
  readonly dialect = "sqlite";
  readonly dbPath: string;
  readonly ftsEnabled: boolean;
  ftsAvailable = false;

  private readonly db: DatabaseSync;
  private readonly maxBusyRetries: number;
  private readonly busyRetryDelayMs: number;
  private closed = false;
  private nestedDepth = 0;
  private savepointCounter = 0;

  /**
   * Create a new SQLite backend for LCM.
   */
  constructor(options: SqliteLcmStorageOptions) {
    this.dbPath = path.resolve(options.dbPath);
    this.ftsEnabled = options.enableFts ?? true;
    this.maxBusyRetries = Math.max(0, options.maxBusyRetries ?? DEFAULT_MAX_BUSY_RETRIES);
    this.busyRetryDelayMs = Math.max(0, options.busyRetryDelayMs ?? DEFAULT_BUSY_RETRY_DELAY_MS);

    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(this.dbPath);
    this.configure({
      busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
      walMode: options.walMode ?? true,
      synchronous: options.synchronous ?? "normal",
    });
  }

  /**
   * Execute a SQL statement without returning rows.
   */
  execute(sql: string, params: LcmSqlParams = []): void {
    this.assertOpen();
    this.db.prepare(sql).run(...params);
  }

  /**
   * Execute a SQL statement and return the first row.
   */
  get<T>(sql: string, params: LcmSqlParams = []): T | undefined {
    this.assertOpen();
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /**
   * Execute a SQL statement and return all rows.
   */
  all<T>(sql: string, params: LcmSqlParams = []): T[] {
    this.assertOpen();
    return this.db.prepare(sql).all(...params) as T[];
  }

  /**
   * Apply all pending schema migrations.
   */
  async migrate(): Promise<void> {
    this.assertOpen();
    this.ensureMigrationsTable();
    const applied = this.readAppliedMigrations();

    for (const migration of LCM_SCHEMA_MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }
      await this.withTransaction(async (tx) => {
        applyMigration(tx, migration);
        tx.execute(
          `INSERT INTO ${SQLITE_MIGRATIONS_TABLE}(version, name, applied_at_ms) VALUES (?, ?, ?)`,
          [migration.version, migration.name, Date.now()],
        );
      });
    }

    this.ftsAvailable = false;
    if (!this.ftsEnabled) {
      return;
    }

    try {
      await this.withTransaction((tx) => {
        for (const statement of LCM_FTS_STATEMENTS) {
          tx.execute(statement);
        }
        tx.execute("DELETE FROM lcm_context_items_fts");
        tx.execute(
          `INSERT INTO lcm_context_items_fts (rowid, item_id, conversation_id, title, body)
           SELECT rowid, item_id, conversation_id, COALESCE(title, ''), body
           FROM lcm_context_items
           WHERE tombstoned = 0`,
        );
      });
      this.ftsAvailable = true;
    } catch (error) {
      if (!isFtsUnavailable(error)) {
        throw error;
      }
      this.ftsAvailable = false;
    }
  }

  /**
   * Run a callback inside a transaction, retrying lock conflicts.
   */
  async withTransaction<T>(
    fn: (tx: LcmStorageConnection) => Promise<T> | T,
    options: LcmTransactionOptions = {},
  ): Promise<T> {
    this.assertOpen();

    if (this.nestedDepth > 0) {
      return this.withSavepoint(fn);
    }

    const retries = Math.max(0, options.retries ?? this.maxBusyRetries);
    const mode = options.mode ?? "immediate";
    const begin = beginSql(mode);

    let attempt = 0;
    while (attempt <= retries) {
      let began = false;
      this.nestedDepth += 1;
      try {
        this.db.exec(begin);
        began = true;
        const result = await fn(this);
        this.db.exec("COMMIT");
        began = false;
        return result;
      } catch (error) {
        if (began) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            // Ignore rollback errors; we propagate the original failure below.
          }
        }
        if (isSqliteBusyError(error) && attempt < retries) {
          attempt += 1;
          await sleep(this.busyRetryDelayMs * attempt);
          continue;
        }
        throw error;
      } finally {
        this.nestedDepth = Math.max(0, this.nestedDepth - 1);
      }
    }

    throw new Error("LCM storage transaction retries exhausted");
  }

  /**
   * Close the database handle.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.db.close();
    this.closed = true;
  }

  private async withSavepoint<T>(fn: (tx: LcmStorageConnection) => Promise<T> | T): Promise<T> {
    const name = `lcm_sp_${++this.savepointCounter}`;
    this.db.exec(`SAVEPOINT ${name}`);
    this.nestedDepth += 1;
    try {
      const result = await fn(this);
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      } finally {
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
      }
      throw error;
    } finally {
      this.nestedDepth = Math.max(0, this.nestedDepth - 1);
    }
  }

  private configure(options: {
    walMode: boolean;
    synchronous: "full" | "normal" | "off";
    busyTimeoutMs: number;
  }): void {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs))}`);
    if (options.walMode) {
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    this.db.exec(`PRAGMA synchronous = ${options.synchronous.toUpperCase()}`);
  }

  private ensureMigrationsTable(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${SQLITE_MIGRATIONS_TABLE} (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      )`,
    );
  }

  private readAppliedMigrations(): Set<number> {
    const rows = this.all<{ version: number }>(
      `SELECT version FROM ${SQLITE_MIGRATIONS_TABLE} ORDER BY version ASC`,
    );
    return new Set(rows.map((row) => row.version));
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("LCM SQLite storage is closed");
    }
  }
}

/**
 * Factory for the default SQLite storage backend.
 */
export function createSqliteLcmStorageBackend(options: SqliteLcmStorageOptions): LcmStorageBackend {
  return new SqliteLcmStorageBackend(options);
}

/**
 * True when the error indicates lock contention in SQLite.
 */
export function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("SQLITE_BUSY") ||
    message.includes("SQLITE_LOCKED") ||
    message.toLowerCase().includes("database is locked")
  );
}

function isFtsUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("fts5") || message.includes("no such module");
}

function beginSql(mode: LcmTransactionMode): string {
  switch (mode) {
    case "deferred":
      return "BEGIN DEFERRED";
    case "exclusive":
      return "BEGIN EXCLUSIVE";
    case "immediate":
      return "BEGIN IMMEDIATE";
  }
}

function applyMigration(tx: LcmStorageConnection, migration: LcmSchemaMigration): void {
  for (const statement of migration.statements) {
    tx.execute(statement);
  }
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
