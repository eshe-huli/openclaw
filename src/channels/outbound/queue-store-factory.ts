import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { QueueStore } from "./queue-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { JsonlAuditStore } from "./jsonl-audit-store.js";
import { MultiBackendQueue } from "./multi-backend-queue.js";
import { SqliteQueueStore } from "./sqlite-queue-store.js";

const log = createSubsystemLogger("queue-store-factory");

export type StoreMode = "auto" | "sqlite" | "redis" | "multi";

export type QueueStoreFactoryConfig = {
  store?: StoreMode;
  redis?: { url?: string; prefix?: string };
  sqlite?: { path?: string };
  audit?: { enabled?: boolean; path?: string; maxSizeMb?: number };
  maxAttempts?: number;
  stateDir?: string;
};

function resolveStateDir(config: QueueStoreFactoryConfig): string {
  return config.stateDir ?? process.env.OPENCLAW_STATE_DIR ?? process.env.CLAWDBOT_STATE_DIR ?? ".";
}

function createAudit(config: QueueStoreFactoryConfig): JsonlAuditStore | null {
  if (config.audit?.enabled === false) {
    return null;
  }
  const stateDir = resolveStateDir(config);
  const auditPath = config.audit?.path ?? join(stateDir, "logs", "outbound-audit.jsonl");
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    return new JsonlAuditStore({
      path: auditPath,
      maxSizeMb: config.audit?.maxSizeMb,
    });
  } catch (err) {
    log.warn("failed to create audit store at " + String(auditPath) + ": " + String(err));
    return null;
  }
}

async function tryCreateRedis(config: QueueStoreFactoryConfig): Promise<QueueStore | null> {
  const url = config.redis?.url ?? process.env.REDIS_URL;
  if (!url) {
    return null;
  }
  try {
    const { createRedisQueueStore } = await import("./redis-queue-store.js");
    return await createRedisQueueStore({
      url,
      prefix: config.redis?.prefix,
      maxAttempts: config.maxAttempts,
    });
  } catch (err) {
    log.warn("redis store unavailable: " + String(err));
    return null;
  }
}

function createSqlite(config: QueueStoreFactoryConfig): QueueStore {
  const stateDir = resolveStateDir(config);
  const dbPath = config.sqlite?.path ?? join(stateDir, "outbound-queue.db");
  return new SqliteQueueStore({ dbPath, maxAttempts: config.maxAttempts });
}

/**
 * Config-driven store resolution.
 *
 * - `"auto"` — Redis if url configured + SQLite fallback
 * - `"sqlite"` — SQLite only
 * - `"redis"` — Redis only (throws if unavailable)
 * - `"multi"` — explicitly both
 *
 * Audit is always-on unless `audit.enabled: false`.
 */
export async function createQueueStore(config: QueueStoreFactoryConfig = {}): Promise<QueueStore> {
  const mode = config.store ?? "auto";
  const audit = createAudit(config);

  if (mode === "sqlite") {
    const sqlite = createSqlite(config);
    log.info("queue store: sqlite");
    return new MultiBackendQueue([sqlite], audit);
  }

  if (mode === "redis") {
    const redis = await tryCreateRedis(config);
    if (!redis) {
      throw new Error("Redis queue store requested but unavailable");
    }
    log.info("queue store: redis");
    return new MultiBackendQueue([redis], audit);
  }

  if (mode === "multi") {
    const stores: QueueStore[] = [];
    const redis = await tryCreateRedis(config);
    if (redis) {
      stores.push(redis);
    }
    stores.push(createSqlite(config));
    log.info(`queue store: multi (${stores.length} backends)`);
    return new MultiBackendQueue(stores, audit);
  }

  // "auto" — Redis if available, always SQLite as fallback
  const stores: QueueStore[] = [];
  const redis = await tryCreateRedis(config);
  if (redis) {
    stores.push(redis);
    log.info("queue store: auto (redis + sqlite)");
  } else {
    log.info("queue store: auto (sqlite only)");
  }
  stores.push(createSqlite(config));
  return new MultiBackendQueue(stores, audit);
}
