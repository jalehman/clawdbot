import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { requireNodeSqlite } from "../../../memory/sqlite.js";

let _db: DatabaseSync | null = null;

export function getLcmConnection(dbPath: string): DatabaseSync {
  // Always try to create a fresh connection if there's any issue with the existing one.
  // This handles: closed connections, corrupted state, race conditions from dispose().
  // The overhead of creating a new connection is minimal for SQLite.
  if (_db) {
    try {
      // Try any query to verify the connection is valid
      _db.exec("SELECT 1");
      return _db;
    } catch {
      // Any error means we need a fresh connection
      try {
        _db.close();
      } catch {
        // Ignore close errors
      }
      _db = null;
    }
  }

  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const { DatabaseSync } = requireNodeSqlite();
  _db = new DatabaseSync(dbPath);

  // Enable WAL mode for better concurrent read performance
  _db.exec("PRAGMA journal_mode = WAL");
  // Enable foreign key enforcement
  _db.exec("PRAGMA foreign_keys = ON");

  return _db;
}

export function closeLcmConnection(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
