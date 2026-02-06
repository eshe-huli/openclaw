import { randomUUID } from "node:crypto";
import type { OutboundMessage } from "./middleware.js";
import type { QueueStore, QueueEntry, QueueStats } from "./queue-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";

const logger = createSubsystemLogger("sqlite-queue-store");

export type SqliteQueueStoreConfig = {
  dbPath?: string;
  maxAttempts?: number;
};

type QueueRow = {
  id: string;
  message: string;
  attempts: number;
  max_attempts: number;
  created_at: number;
  next_attempt_at: number;
  status: string;
  last_error: string | null;
};

type PreparedStatements = {
  insert: ReturnType<InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>["prepare"]>;
  dequeueSelect: ReturnType<
    InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>["prepare"]
  >;
  dequeueUpdate: ReturnType<
    InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>["prepare"]
  >;
  complete: ReturnType<
    InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>["prepare"]
  >;
  failUpdate: ReturnType<
    InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>["prepare"]
  >;
  failMoveToDead: ReturnType<
    InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>["prepare"]
  >;
  deadLetters: ReturnType<
    InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>["prepare"]
  >;
  retryDeadLetter: ReturnType<
    InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>["prepare"]
  >;
  purgeDeadLetters: ReturnType<
    InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>["prepare"]
  >;
  statsPending: ReturnType<
    InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>["prepare"]
  >;
  statsProcessing: ReturnType<
    InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>["prepare"]
  >;
  statsDead: ReturnType<
    InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>["prepare"]
  >;
};

export class SqliteQueueStore implements QueueStore {
  private db: InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;
  private stmts!: PreparedStatements;
  private maxAttempts: number;

  constructor(config: SqliteQueueStoreConfig = {}) {
    const { DatabaseSync } = requireNodeSqlite();
    const dbPath = config.dbPath ?? ":memory:";
    this.maxAttempts = config.maxAttempts ?? 3;

    logger.info(`Initializing SQLite queue store at ${dbPath}`);
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init(): void {
    // Enable WAL mode for better concurrency
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");

    // Create table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbound_queue (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'dead')),
        last_error TEXT
      )
    `);

    // Create index for efficient dequeue queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_outbound_queue_dequeue
      ON outbound_queue(status, next_attempt_at)
      WHERE status IN ('pending', 'processing')
    `);

    // Prepare all statements (cached for reuse)
    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO outbound_queue (id, message, attempts, max_attempts, created_at, next_attempt_at, status)
        VALUES (?, ?, 0, ?, ?, ?, 'pending')
      `),

      dequeueSelect: this.db.prepare(`
        SELECT id FROM outbound_queue
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY created_at ASC
        LIMIT ?
      `),

      dequeueUpdate: this.db.prepare(`
        UPDATE outbound_queue
        SET status = 'processing', attempts = attempts + 1
        WHERE id = ?
        RETURNING *
      `),

      complete: this.db.prepare(`
        DELETE FROM outbound_queue WHERE id = ?
      `),

      failUpdate: this.db.prepare(`
        UPDATE outbound_queue
        SET last_error = ?, next_attempt_at = ?
        WHERE id = ?
      `),

      failMoveToDead: this.db.prepare(`
        UPDATE outbound_queue
        SET status = 'dead', last_error = ?
        WHERE id = ?
      `),

      deadLetters: this.db.prepare(`
        SELECT * FROM outbound_queue
        WHERE status = 'dead'
        ORDER BY created_at DESC
        LIMIT ?
      `),

      retryDeadLetter: this.db.prepare(`
        UPDATE outbound_queue
        SET status = 'pending', attempts = 0, next_attempt_at = ?
        WHERE id = ? AND status = 'dead'
      `),

      purgeDeadLetters: this.db.prepare(`
        DELETE FROM outbound_queue WHERE status = 'dead'
      `),

      statsPending: this.db.prepare(`
        SELECT COUNT(*) as count FROM outbound_queue WHERE status = 'pending'
      `),

      statsProcessing: this.db.prepare(`
        SELECT COUNT(*) as count FROM outbound_queue WHERE status = 'processing'
      `),

      statsDead: this.db.prepare(`
        SELECT COUNT(*) as count FROM outbound_queue WHERE status = 'dead'
      `),
    };

    logger.info("SQLite queue store initialized with cached statements");
  }

  async enqueue(msg: OutboundMessage, id?: string): Promise<string> {
    const queueId = id ?? randomUUID();
    const now = Date.now();

    this.stmts.insert.run(queueId, JSON.stringify(msg), this.maxAttempts, now, now);

    logger.debug(`Enqueued message ${queueId} to ${msg.channel}`);
    return queueId;
  }

  async dequeue(limit: number): Promise<QueueEntry[]> {
    const now = Date.now();

    // Use transaction for atomic dequeue
    this.db.exec("BEGIN");
    try {
      // Select pending messages
      const candidates = this.stmts.dequeueSelect.all(now, limit) as Array<{ id: string }>;

      if (candidates.length === 0) {
        this.db.exec("COMMIT");
        return [];
      }

      // Update to processing and return
      const entries: QueueEntry[] = [];
      for (const { id } of candidates) {
        const rows = this.stmts.dequeueUpdate.all(id) as QueueRow[];
        if (rows.length > 0) {
          entries.push(this.rowToEntry(rows[0]));
        }
      }

      this.db.exec("COMMIT");
      logger.debug(`Dequeued ${entries.length} messages`);
      return entries;
    } catch (error) {
      this.db.exec("ROLLBACK");
      logger.error("Dequeue transaction failed", { error });
      throw error;
    }
  }

  async complete(id: string): Promise<void> {
    this.stmts.complete.run(id);
    logger.debug(`Completed message ${id}`);
  }

  async fail(id: string, error: string): Promise<void> {
    // Get current entry to check attempts
    const row = this.db.prepare("SELECT * FROM outbound_queue WHERE id = ?").get(id) as
      | QueueRow
      | undefined;

    if (!row) {
      logger.warn(`Cannot fail non-existent message ${id}`);
      return;
    }

    const newAttempts = row.attempts + 1;

    if (newAttempts >= row.max_attempts) {
      // Move to dead letter queue
      this.stmts.failMoveToDead.run(error, id);
      logger.warn(`Message ${id} moved to dead letter queue after ${newAttempts} attempts`);
    } else {
      // Exponential backoff: 2^attempts seconds
      const backoffMs = Math.min(30_000, Math.pow(2, newAttempts) * 1000);
      const nextAttempt = Date.now() + backoffMs;

      // Reset status to pending for retry, update attempts
      this.db
        .prepare(`
        UPDATE outbound_queue
        SET status = 'pending', attempts = ?, last_error = ?, next_attempt_at = ?
        WHERE id = ?
      `)
        .run(newAttempts, error, nextAttempt, id);

      logger.debug(`Message ${id} scheduled for retry in ${backoffMs}ms (attempt ${newAttempts})`);
    }
  }

  async deadLetters(limit: number): Promise<QueueEntry[]> {
    const rows = this.stmts.deadLetters.all(limit) as QueueRow[];
    return rows.map((row) => this.rowToEntry(row));
  }

  async retryDeadLetter(id: string): Promise<boolean> {
    const now = Date.now();
    const result = this.stmts.retryDeadLetter.run(now, id);
    const changed = (result as { changes: number }).changes > 0;

    if (changed) {
      logger.info(`Retrying dead letter ${id}`);
    }

    return changed;
  }

  async purgeDeadLetters(): Promise<number> {
    const result = this.stmts.purgeDeadLetters.run();
    const count = (result as { changes: number }).changes;
    logger.info(`Purged ${count} dead letters`);
    return count;
  }

  async stats(): Promise<QueueStats> {
    const pending = (this.stmts.statsPending.get() as { count: number }).count;
    const processing = (this.stmts.statsProcessing.get() as { count: number }).count;
    const dead = (this.stmts.statsDead.get() as { count: number }).count;

    return { pending, processing, dead };
  }

  async close(): Promise<void> {
    logger.info("Closing SQLite queue store");
    this.db.close();
  }

  private rowToEntry(row: QueueRow): QueueEntry {
    return {
      id: row.id,
      message: JSON.parse(row.message) as OutboundMessage,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at,
      nextAttemptAt: row.next_attempt_at,
      status: row.status as "pending" | "processing" | "dead",
      lastError: row.last_error ?? undefined,
    };
  }
}
