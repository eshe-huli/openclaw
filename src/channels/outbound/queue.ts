import { randomUUID } from "node:crypto";
import type { OutboundMessage, OutboundResult } from "./middleware.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";

const log = createSubsystemLogger("outbound-queue");

export type QueueEntry = {
  id: string;
  message: OutboundMessage;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  nextAttemptAt: number;
  status: "pending" | "processing" | "dead";
  lastError?: string;
};

export type QueueConfig = {
  /** Path to SQLite database file. Default: ":memory:" */
  dbPath?: string;
  /** Max retry attempts before moving to dead letter. Default: 5 */
  maxAttempts?: number;
};

export class OutboundQueue {
  private db: InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;
  private maxAttempts: number;

  constructor(config: QueueConfig = {}) {
    const sqlite = requireNodeSqlite();
    this.db = new sqlite.DatabaseSync(config.dbPath ?? ":memory:");
    this.maxAttempts = config.maxAttempts ?? 5;
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbound_queue (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_queue_status_next
        ON outbound_queue(status, next_attempt_at)
    `);
    log.debug("outbound queue initialized");
  }

  enqueue(msg: OutboundMessage): string {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO outbound_queue (id, message, attempts, max_attempts, created_at, next_attempt_at, status)
         VALUES (?, ?, 0, ?, ?, ?, 'pending')`,
      )
      .run(id, JSON.stringify(msg), this.maxAttempts, now, now);
    return id;
  }

  /** Fetch up to `limit` messages ready for delivery. */
  dequeue(limit = 10): QueueEntry[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT id, message, attempts, max_attempts, created_at, next_attempt_at, status, last_error
         FROM outbound_queue
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC
         LIMIT ?`,
      )
      .all(now, limit) as Array<{
      id: string;
      message: string;
      attempts: number;
      max_attempts: number;
      created_at: number;
      next_attempt_at: number;
      status: string;
      last_error: string | null;
    }>;

    const entries: QueueEntry[] = [];
    for (const row of rows) {
      this.db.prepare(`UPDATE outbound_queue SET status = 'processing' WHERE id = ?`).run(row.id);
      entries.push({
        id: row.id,
        message: JSON.parse(row.message) as OutboundMessage,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        createdAt: row.created_at,
        nextAttemptAt: row.next_attempt_at,
        status: "processing",
        lastError: row.last_error ?? undefined,
      });
    }
    return entries;
  }

  /** Mark entry as successfully delivered and remove from queue. */
  complete(id: string): void {
    this.db.prepare(`DELETE FROM outbound_queue WHERE id = ?`).run(id);
  }

  /** Record a failed attempt. Move to dead letter if max attempts reached. */
  fail(id: string, error: string): void {
    const row = this.db
      .prepare(`SELECT attempts, max_attempts FROM outbound_queue WHERE id = ?`)
      .get(id) as { attempts: number; max_attempts: number } | undefined;
    if (!row) return;

    const newAttempts = row.attempts + 1;
    if (newAttempts >= row.max_attempts) {
      this.db
        .prepare(
          `UPDATE outbound_queue SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?`,
        )
        .run(newAttempts, error, id);
      log.warn(`message ${id} moved to dead letter after ${newAttempts} attempts: ${error}`);
      return;
    }

    // Exponential backoff for next attempt
    const delayMs = Math.min(30_000, 1000 * 2 ** newAttempts);
    const nextAttemptAt = Date.now() + delayMs;
    this.db
      .prepare(
        `UPDATE outbound_queue SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`,
      )
      .run(newAttempts, nextAttemptAt, error, id);
  }

  /** Get dead letter entries. */
  deadLetters(limit = 100): QueueEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, message, attempts, max_attempts, created_at, next_attempt_at, status, last_error
         FROM outbound_queue WHERE status = 'dead' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      message: string;
      attempts: number;
      max_attempts: number;
      created_at: number;
      next_attempt_at: number;
      status: string;
      last_error: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      message: JSON.parse(row.message) as OutboundMessage,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at,
      nextAttemptAt: row.next_attempt_at,
      status: "dead" as const,
      lastError: row.last_error ?? undefined,
    }));
  }

  /** Get queue stats. */
  stats(): { pending: number; processing: number; dead: number } {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) as count FROM outbound_queue GROUP BY status`)
      .all() as Array<{ status: string; count: number }>;

    const result = { pending: 0, processing: 0, dead: 0 };
    for (const row of rows) {
      if (row.status in result) {
        result[row.status as keyof typeof result] = row.count;
      }
    }
    return result;
  }

  close(): void {
    this.db.close();
  }
}
