import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { requireNodeSqlite } from "../../../memory/sqlite.js";

let _db: DatabaseSync | null = null;

export function getLcmConnection(dbPath: string): DatabaseSync {
  // If we have a connection but it fails any health check, create a fresh one
  // instead of failing later with "database is not open" (or other sqlite errors).
  if (_db) {
    try {
      _db.prepare("SELECT 1").get();
      return _db;
    } catch {
      // Connection is closed or invalid - close defensively and recreate it.
      try {
        _db.close();
      } catch {
        // Ignore close failures and replace the handle.
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
