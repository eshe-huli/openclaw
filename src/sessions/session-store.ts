/**
 * Pluggable SessionStore abstraction layer.
 *
 * Provides a backend-agnostic interface for persisting session conversation
 * entries (the JSONL data that pi-coding-agent's SessionManager manages).
 *
 * Architecture: "parallel persistence" — SessionManager keeps its JSONL files
 * for in-memory tree operations, and this layer mirrors writes to a durable
 * backend (Redis Streams / SQLite / JSONL). On session load, the backend can
 * hydrate the JSONL file before SessionManager opens it.
 */

import type {
  FileEntry,
  SessionEntry as PiSessionEntry,
  SessionHeader,
} from "@mariozechner/pi-coding-agent";

// Re-export the pi-coding-agent types for convenience
export type { FileEntry, PiSessionEntry, SessionHeader };

/**
 * Size metadata for a session in the backend.
 */
export type SessionSizeInfo = {
  /** Number of entries stored (excluding header). */
  entries: number;
  /** Approximate total bytes of serialized entries. */
  bytes: number;
};

/**
 * Backend interface for pluggable session storage.
 *
 * Each backend implements this interface to provide durable persistence
 * for session conversation entries. The entries correspond to the JSONL
 * lines that pi-coding-agent's SessionManager reads/writes.
 */
export interface SessionBackend {
  /** Human-readable backend name (e.g. "redis-stream", "sqlite", "jsonl"). */
  readonly name: string;

  /**
   * Load all entries for a session (header + session entries).
   * Used to hydrate a JSONL file before SessionManager opens it.
   */
  loadEntries(sessionId: string): Promise<FileEntry[]>;

  /**
   * Append a single entry to the session.
   * Called after SessionManager persists to JSONL, to mirror the write.
   */
  append(sessionId: string, entry: FileEntry): Promise<void>;

  /**
   * Get the most recent entries for context building (chunked read).
   * Returns up to `limit` entries, optionally capped at `maxBytes` of
   * serialized JSON.
   */
  getRecent(sessionId: string, limit: number, maxBytes?: number): Promise<FileEntry[]>;

  /**
   * Trim a session to keep only the last `keepEntries` entries.
   * The session header is always preserved.
   */
  trim(sessionId: string, keepEntries: number): Promise<void>;

  /**
   * Rewrite the entire session with a new set of entries.
   * Used after compaction to replace the session contents atomically.
   */
  rewrite(sessionId: string, entries: FileEntry[]): Promise<void>;

  /**
   * Get size metadata for a session.
   */
  size(sessionId: string): Promise<SessionSizeInfo>;

  /**
   * Delete all data for a session.
   */
  delete(sessionId: string): Promise<void>;

  /**
   * Check if the backend is healthy and available.
   * Returns true if the backend can accept reads/writes.
   */
  ping(): Promise<boolean>;

  /**
   * Gracefully close the backend (release connections, etc.).
   */
  close(): Promise<void>;
}

/**
 * Configuration for the session store subsystem.
 */
export type SessionStoreConfig = {
  /** Backend selection: "auto" tries redis → sqlite → jsonl. */
  store?: "auto" | "redis-stream" | "sqlite" | "jsonl";
  redis?: {
    url?: string;
    prefix?: string;
  };
  sqlite?: {
    path?: string;
  };
  /** Max entries before triggering compaction. */
  maxEntries?: number;
  /** Byte threshold to trigger compaction. */
  compactionTriggerBytes?: number;
};
