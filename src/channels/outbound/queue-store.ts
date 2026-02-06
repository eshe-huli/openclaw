import type { OutboundMessage } from "./middleware.js";

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

export type QueueStats = {
  pending: number;
  processing: number;
  dead: number;
};

/**
 * Backend-agnostic queue store interface.
 *
 * Implementations: SQLite, Redis, JSONL (audit-only).
 * All methods are async so network-backed stores work transparently.
 */
export interface QueueStore {
  /** Add a message to the queue. Caller may supply a shared `id` for multi-backend dedup. */
  enqueue(msg: OutboundMessage, id?: string): Promise<string>;
  /** Fetch up to `limit` messages ready for delivery, atomically marking them processing. */
  dequeue(limit: number): Promise<QueueEntry[]>;
  /** Mark a message as successfully delivered (remove from queue). */
  complete(id: string): Promise<void>;
  /** Record a failed attempt; move to dead letter when max attempts reached. */
  fail(id: string, error: string): Promise<void>;
  /** Retrieve dead-letter entries. */
  deadLetters(limit: number): Promise<QueueEntry[]>;
  /** Move a dead letter back to pending for retry. */
  retryDeadLetter(id: string): Promise<boolean>;
  /** Purge all dead letters. Returns count deleted. */
  purgeDeadLetters(): Promise<number>;
  /** Get queue statistics. */
  stats(): Promise<QueueStats>;
  /** Gracefully shut down the store. */
  close(): Promise<void>;
}
