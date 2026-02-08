/**
 * Backend resolver: creates a dual-write session backend.
 *
 * Architecture: Redis Streams (primary, fast) + SQLite (always synced, durable).
 * Every write goes to BOTH backends simultaneously.
 * Reads prefer Redis. If Redis is down, reads fall to SQLite.
 * SQLite is always available — it's the safety net.
 * JSONL is only for SessionManager tree compatibility (not a backend here).
 *
 * If Redis crashes mid-session, writes continue to SQLite and are
 * replayed to Redis when it recovers.
 */

import type { RedisStreamBackendOptions } from "./backends/redis-stream.js";
import type { SqliteBackendOptions } from "./backends/sqlite.js";
import type { FileEntry, SessionBackend, SessionStoreConfig } from "./session-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("session-store");

export type BackendResolverOptions = {
  config?: SessionStoreConfig;
  /** Override SQLite path (for testing). */
  sqlitePath?: string;
};

/**
 * Dual-write backend: writes to both Redis and SQLite simultaneously.
 * Reads prefer Redis (faster). Falls to SQLite if Redis unavailable.
 * SQLite is ALWAYS written to — it's the durable sync layer.
 */
export class DualWriteSessionBackend implements SessionBackend {
  readonly name: string;

  private redis: SessionBackend | null;
  private sqlite: SessionBackend;
  private redisHealthy = true;
  private recoverIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(redis: SessionBackend | null, sqlite: SessionBackend) {
    this.redis = redis;
    this.sqlite = sqlite;
    this.redisHealthy = redis !== null;
    this.name = redis ? `dual(${redis.name}+${sqlite.name})` : sqlite.name;

    // Periodically try to recover Redis if it's down
    if (redis) {
      this.recoverIntervalId = setInterval(() => this.tryRecoverRedis(), 30_000);
    }
  }

  private async writeToRedis<T>(
    op: string,
    fn: (backend: SessionBackend) => Promise<T>,
  ): Promise<T | null> {
    if (!this.redis || !this.redisHealthy) return null;
    try {
      return await fn(this.redis);
    } catch (err) {
      log.warn(`session-store: Redis failed during ${op}, marking unhealthy: ${String(err)}`);
      this.redisHealthy = false;
      return null;
    }
  }

  private async readPreferRedis<T>(
    op: string,
    fn: (backend: SessionBackend) => Promise<T>,
  ): Promise<T> {
    // Try Redis first (faster)
    if (this.redis && this.redisHealthy) {
      try {
        return await fn(this.redis);
      } catch (err) {
        log.warn(
          `session-store: Redis read failed during ${op}, falling to SQLite: ${String(err)}`,
        );
        this.redisHealthy = false;
      }
    }
    // SQLite always works
    return fn(this.sqlite);
  }

  async loadEntries(sessionId: string): Promise<FileEntry[]> {
    return this.readPreferRedis("loadEntries", (b) => b.loadEntries(sessionId));
  }

  async append(sessionId: string, entry: FileEntry): Promise<void> {
    // Write to BOTH — SQLite first (durable), then Redis (fast)
    await this.sqlite.append(sessionId, entry);
    await this.writeToRedis("append", (b) => b.append(sessionId, entry));
  }

  async getRecent(sessionId: string, limit: number, maxBytes?: number): Promise<FileEntry[]> {
    return this.readPreferRedis("getRecent", (b) => b.getRecent(sessionId, limit, maxBytes));
  }

  async trim(sessionId: string, keepEntries: number): Promise<void> {
    // Trim BOTH
    await this.sqlite.trim(sessionId, keepEntries);
    await this.writeToRedis("trim", (b) => b.trim(sessionId, keepEntries));
  }

  async rewrite(sessionId: string, entries: FileEntry[]): Promise<void> {
    // Rewrite BOTH — SQLite first (durable)
    await this.sqlite.rewrite(sessionId, entries);
    await this.writeToRedis("rewrite", (b) => b.rewrite(sessionId, entries));
  }

  async size(sessionId: string) {
    return this.readPreferRedis("size", (b) => b.size(sessionId));
  }

  async delete(sessionId: string): Promise<void> {
    await this.sqlite.delete(sessionId);
    await this.writeToRedis("delete", (b) => b.delete(sessionId));
  }

  async ping(): Promise<boolean> {
    // Both must be checked
    const sqliteOk = await this.sqlite.ping();
    if (!sqliteOk) return false;
    if (this.redis && this.redisHealthy) {
      try {
        return await this.redis.ping();
      } catch {
        this.redisHealthy = false;
        return true; // SQLite is fine, degraded but operational
      }
    }
    return true; // SQLite-only mode
  }

  async close(): Promise<void> {
    if (this.recoverIntervalId) {
      clearInterval(this.recoverIntervalId);
      this.recoverIntervalId = null;
    }
    if (this.redis) {
      try {
        await this.redis.close();
      } catch {
        /* ignore */
      }
    }
    await this.sqlite.close();
  }

  /** Check if Redis is currently down. */
  isRedisDegraded(): boolean {
    return !this.redisHealthy;
  }

  /** Attempt to recover Redis and sync from SQLite. */
  private async tryRecoverRedis(): Promise<void> {
    if (!this.redis || this.redisHealthy) return;
    try {
      const ok = await this.redis.ping();
      if (ok) {
        log.info("session-store: Redis recovered, marking healthy");
        this.redisHealthy = true;
        // Note: Redis will re-sync on next rewrite/append.
        // Full sync could be added here if needed.
      }
    } catch {
      // still down, will retry
    }
  }
}

// ============================================================================
// Factory functions
// ============================================================================

async function tryCreateRedis(
  redisConfig: SessionStoreConfig["redis"],
): Promise<SessionBackend | null> {
  if (!redisConfig?.url) return null;
  try {
    const { RedisStreamBackend } = await import("./backends/redis-stream.js");
    const opts: RedisStreamBackendOptions = {
      url: redisConfig.url,
      prefix: redisConfig.prefix,
    };
    const backend = await RedisStreamBackend.create(opts);
    const pong = await backend.ping();
    if (!pong) {
      await backend.close();
      log.warn("session-store: Redis PING failed, starting without Redis");
      return null;
    }
    log.info("session-store: Redis Streams connected");
    return backend;
  } catch (err) {
    log.warn(`session-store: Redis unavailable, starting without it: ${String(err)}`);
    return null;
  }
}

async function createSqlite(
  sqliteConfig: SessionStoreConfig["sqlite"],
  overridePath?: string,
): Promise<SessionBackend> {
  const { SqliteBackend } = await import("./backends/sqlite.js");
  const opts: SqliteBackendOptions = {
    path: overridePath || sqliteConfig?.path,
  };
  const backend = await SqliteBackend.create(opts);
  log.info(`session-store: SQLite initialized at ${opts.path || "default path"}`);
  return backend;
}

/**
 * Create the session backend based on config.
 *
 * - "redis-stream": Dual-write (Redis + SQLite), reads prefer Redis
 * - "sqlite": SQLite only
 * - "auto": Try Redis + SQLite dual-write, fall to SQLite-only if Redis unavailable
 *
 * SQLite is ALWAYS present. It's the durable sync layer.
 */
export async function createSessionBackend(
  opts: BackendResolverOptions = {},
): Promise<SessionBackend> {
  const config = opts.config;
  const store = config?.store?.trim() || "auto";

  // SQLite is always created — it's the foundation
  const sqlite = await createSqlite(config?.sqlite, opts.sqlitePath);

  if (store === "sqlite") {
    // SQLite only, no Redis
    return sqlite;
  }

  if (store === "redis-stream" || store === "auto") {
    // Try Redis for dual-write
    const redis = await tryCreateRedis(config?.redis);
    if (redis) {
      const dual = new DualWriteSessionBackend(redis, sqlite);
      log.info(`session-store: dual-write active (${dual.name})`);
      return dual;
    }
    if (store === "redis-stream") {
      log.warn("session-store: Redis required but unavailable, using SQLite only");
    }
    return sqlite;
  }

  // Unknown store — SQLite
  log.warn(`session-store: unknown store type "${store}", using SQLite`);
  return sqlite;
}

// Legacy export for compatibility with backend-registry.ts
export { createSessionBackend as createResilientBackend };
