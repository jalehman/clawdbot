import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { requireNodeSqlite } from "../../../memory/sqlite.js";

let _db: DatabaseSync | null = null;

export function getLcmConnection(dbPath: string): DatabaseSync {
  if (!_db) {
    // Ensure parent directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    const { DatabaseSync } = requireNodeSqlite();
    _db = new DatabaseSync(dbPath);

    // Enable WAL mode for better concurrent read performance
    _db.exec("PRAGMA journal_mode = WAL");
    // Enable foreign key enforcement
    _db.exec("PRAGMA foreign_keys = ON");
  }
  return _db;
}

export function closeLcmConnection(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
