/**
 * SQLite backend for session storage.
 *
 * Uses better-sqlite3 for synchronous, fast local persistence.
 * Table schema: sessions(session_id TEXT, seq INTEGER, entry_json TEXT, created_at INTEGER)
 *
 * Falls back gracefully if better-sqlite3 is not installed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileEntry, SessionBackend, SessionSizeInfo } from "../session-store.js";

const DEFAULT_DB_PATH = "~/.openclaw/sessions.db";

export type SqliteBackendOptions = {
  /** Path to SQLite database file (supports ~ expansion). */
  path?: string;
};

type BetterSqlite3Database = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(sql: string): void;
  close(): void;
  pragma(key: string): unknown;
};

export class SqliteBackend implements SessionBackend {
  readonly name = "sqlite";

  private db: BetterSqlite3Database;
  private dbPath: string;

  private constructor(db: BetterSqlite3Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /**
   * Create a SqliteBackend. Dynamically imports better-sqlite3.
   */
  static async create(opts: SqliteBackendOptions = {}): Promise<SqliteBackend> {
    const rawPath = opts.path?.trim() || DEFAULT_DB_PATH;
    const resolvedPath = rawPath.startsWith("~")
      ? path.resolve(rawPath.replace(/^~(?=$|[\\/])/, os.homedir()))
      : path.resolve(rawPath);

    // Ensure parent directory exists
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Try Bun's built-in SQLite first, then fall to better-sqlite3
    let db: BetterSqlite3Database;
    const isBun = typeof (globalThis as any).Bun !== "undefined";

    if (isBun) {
      try {
        // Bun's built-in bun:sqlite has a compatible API
        // Use Function constructor to avoid static analysis/bundler issues
        const bunSqlite = (await new Function("return import('bun:sqlite')")()) as {
          Database: new (path: string) => BetterSqlite3Database;
        };
        db = new bunSqlite.Database(resolvedPath);
      } catch {
        throw new Error("bun:sqlite failed to initialize. This should not happen in Bun runtime.");
      }
    } else {
      try {
        const mod = (await import("better-sqlite3")) as unknown as {
          default: new (path: string) => BetterSqlite3Database;
        };
        db = new mod.default(resolvedPath);
      } catch {
        throw new Error(
          "better-sqlite3 is not installed. Install it with: pnpm add better-sqlite3 @types/better-sqlite3",
        );
      }
    }

    // Enable WAL mode for better concurrent read performance
    if (typeof db.pragma === "function") {
      db.pragma("journal_mode = WAL");
    } else {
      // bun:sqlite — use exec instead
      try {
        db.exec("PRAGMA journal_mode = WAL");
      } catch {
        /* ignore */
      }
    }

    // Create table if not exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        entry_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      )
    `);

    // Index for fast lookups by session_id
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_id
      ON sessions (session_id, seq)
    `);

    return new SqliteBackend(db, resolvedPath);
  }

  async loadEntries(sessionId: string): Promise<FileEntry[]> {
    const rows = this.db
      .prepare("SELECT entry_json FROM sessions WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as Array<{ entry_json: string }>;

    const entries: FileEntry[] = [];
    for (const row of rows) {
      try {
        entries.push(JSON.parse(row.entry_json) as FileEntry);
      } catch {
        // skip malformed
      }
    }
    return entries;
  }

  async append(sessionId: string, entry: FileEntry): Promise<void> {
    const json = JSON.stringify(entry);
    const now = Date.now();

    // Get next sequence number
    const maxRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), -1) as max_seq FROM sessions WHERE session_id = ?")
      .get(sessionId) as { max_seq: number } | undefined;
    const nextSeq = (maxRow?.max_seq ?? -1) + 1;

    this.db
      .prepare("INSERT INTO sessions (session_id, seq, entry_json, created_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, nextSeq, json, now);
  }

  async getRecent(sessionId: string, limit: number, maxBytes?: number): Promise<FileEntry[]> {
    // Get total count first for offset calculation
    const rows = this.db
      .prepare("SELECT entry_json FROM sessions WHERE session_id = ? ORDER BY seq DESC LIMIT ?")
      .all(sessionId, limit) as Array<{ entry_json: string }>;

    const entries: FileEntry[] = [];
    let totalBytes = 0;

    for (const row of rows) {
      if (maxBytes !== undefined && totalBytes + row.entry_json.length > maxBytes) {
        break;
      }
      totalBytes += row.entry_json.length;
      try {
        entries.push(JSON.parse(row.entry_json) as FileEntry);
      } catch {
        // skip
      }
    }

    // Reverse to chronological order (we fetched DESC)
    entries.reverse();
    return entries;
  }

  async trim(sessionId: string, keepEntries: number): Promise<void> {
    // Keep the header (seq=0) plus the last `keepEntries` session entries
    // First, find the seq threshold
    const row = this.db
      .prepare(`SELECT seq FROM sessions WHERE session_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?`)
      .get(sessionId, keepEntries) as { seq: number } | undefined;

    if (row) {
      // Delete everything before this threshold, except seq=0 (header)
      this.db
        .prepare("DELETE FROM sessions WHERE session_id = ? AND seq > 0 AND seq < ?")
        .run(sessionId, row.seq);
    }
  }

  async rewrite(sessionId: string, entries: FileEntry[]): Promise<void> {
    const now = Date.now();

    // Delete all existing entries and re-insert
    this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);

    const insert = this.db.prepare(
      "INSERT INTO sessions (session_id, seq, entry_json, created_at) VALUES (?, ?, ?, ?)",
    );

    for (let i = 0; i < entries.length; i++) {
      const json = JSON.stringify(entries[i]);
      insert.run(sessionId, i, json, now);
    }
  }

  async size(sessionId: string): Promise<SessionSizeInfo> {
    const countRow = this.db
      .prepare("SELECT COUNT(*) as cnt FROM sessions WHERE session_id = ?")
      .get(sessionId) as { cnt: number } | undefined;
    const count = countRow?.cnt ?? 0;

    const bytesRow = this.db
      .prepare(
        "SELECT COALESCE(SUM(LENGTH(entry_json)), 0) as total_bytes FROM sessions WHERE session_id = ?",
      )
      .get(sessionId) as { total_bytes: number } | undefined;
    const bytes = bytesRow?.total_bytes ?? 0;

    // Subtract 1 for header
    const entryCount = Math.max(0, count - 1);
    return { entries: entryCount, bytes };
  }

  async delete(sessionId: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  async ping(): Promise<boolean> {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // ignore close errors
    }
  }
}
