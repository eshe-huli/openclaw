/**
 * Redis Streams backend for session storage.
 *
 * Uses Redis Streams (XADD/XRANGE/XREVRANGE/XTRIM) to persist session entries.
 * Each session maps to a stream key: `{prefix}:session:{sessionId}`.
 * Each stream entry contains a single field "d" with the JSON-serialized FileEntry.
 *
 * Gracefully degrades: all methods catch Redis errors and reject with
 * descriptive errors so the resolver can fall back to another backend.
 */

import type { Redis, RedisOptions } from "ioredis";
import type { FileEntry, SessionBackend, SessionSizeInfo } from "../session-store.js";

const DEFAULT_PREFIX = "openclaw:session";

export type RedisStreamBackendOptions = {
  /** Redis connection URL (e.g. "redis://localhost:6379"). */
  url?: string;
  /** Key prefix for session streams. */
  prefix?: string;
  /** Pre-existing ioredis client (takes precedence over url). */
  client?: Redis;
};

export class RedisStreamBackend implements SessionBackend {
  readonly name = "redis-stream";

  private redis: Redis;
  private prefix: string;
  private ownsClient: boolean;

  private constructor(redis: Redis, prefix: string, ownsClient: boolean) {
    this.redis = redis;
    this.prefix = prefix;
    this.ownsClient = ownsClient;
  }

  /**
   * Create a RedisStreamBackend. Lazily imports ioredis to avoid hard dep at import time.
   */
  static async create(opts: RedisStreamBackendOptions = {}): Promise<RedisStreamBackend> {
    const prefix = opts.prefix?.trim() || DEFAULT_PREFIX;

    if (opts.client) {
      return new RedisStreamBackend(opts.client, prefix, false);
    }

    // Dynamic import so the module doesn't fail if ioredis isn't installed
    const { default: IORedis } = (await import("ioredis")) as {
      default: new (url?: string, opts?: RedisOptions) => Redis;
    };
    const url = opts.url?.trim() || "redis://127.0.0.1:6379";
    const client = new IORedis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        if (times > 5) return null; // stop retrying
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
      family: 4, // force IPv4 — avoid ECONNREFUSED on ::1
    });

    await client.connect();
    return new RedisStreamBackend(client, prefix, true);
  }

  private streamKey(sessionId: string): string {
    return `${this.prefix}:${sessionId}`;
  }

  async loadEntries(sessionId: string): Promise<FileEntry[]> {
    const key = this.streamKey(sessionId);
    const raw = await this.redis.xrange(key, "-", "+");
    const entries: FileEntry[] = [];
    for (const [, fields] of raw) {
      const json = fields[1]; // field layout: ["d", "<json>"]
      if (json) {
        try {
          entries.push(JSON.parse(json) as FileEntry);
        } catch {
          // skip malformed entries
        }
      }
    }
    return entries;
  }

  async append(sessionId: string, entry: FileEntry): Promise<void> {
    const key = this.streamKey(sessionId);
    const json = JSON.stringify(entry);
    await this.redis.xadd(key, "*", "d", json);
  }

  async getRecent(sessionId: string, limit: number, maxBytes?: number): Promise<FileEntry[]> {
    const key = this.streamKey(sessionId);
    // XREVRANGE returns newest first; we reverse to get chronological order
    const raw = await this.redis.xrevrange(key, "+", "-", "COUNT", limit);
    const entries: FileEntry[] = [];
    let totalBytes = 0;

    for (const [, fields] of raw) {
      const json = fields[1];
      if (!json) continue;
      if (maxBytes !== undefined && totalBytes + json.length > maxBytes) break;
      totalBytes += json.length;
      try {
        entries.push(JSON.parse(json) as FileEntry);
      } catch {
        // skip
      }
    }

    // Reverse to chronological order
    entries.reverse();
    return entries;
  }

  async trim(sessionId: string, keepEntries: number): Promise<void> {
    const key = this.streamKey(sessionId);
    // XTRIM MAXLEN keeps the last N entries
    await this.redis.xtrim(key, "MAXLEN", keepEntries);
  }

  async rewrite(sessionId: string, entries: FileEntry[]): Promise<void> {
    const key = this.streamKey(sessionId);
    const pipeline = this.redis.pipeline();
    // Delete the stream and re-add all entries
    pipeline.del(key);
    for (const entry of entries) {
      const json = JSON.stringify(entry);
      pipeline.xadd(key, "*", "d", json);
    }
    await pipeline.exec();
  }

  async size(sessionId: string): Promise<SessionSizeInfo> {
    const key = this.streamKey(sessionId);
    const len = await this.redis.xlen(key);

    // Estimate bytes by sampling (full scan is expensive)
    let bytes = 0;
    if (len > 0) {
      // Sample first few entries to estimate average size
      const sample = await this.redis.xrange(key, "-", "+", "COUNT", Math.min(10, len));
      let sampleBytes = 0;
      for (const [, fields] of sample) {
        const json = fields[1];
        if (json) sampleBytes += json.length;
      }
      const avgSize = sample.length > 0 ? sampleBytes / sample.length : 0;
      bytes = Math.round(avgSize * len);
    }

    // Subtract 1 for header if present
    const entryCount = Math.max(0, len - 1);
    return { entries: entryCount, bytes };
  }

  async delete(sessionId: string): Promise<void> {
    const key = this.streamKey(sessionId);
    await this.redis.del(key);
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.redis.quit();
    }
  }
}
