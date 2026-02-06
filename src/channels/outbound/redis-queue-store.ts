import { randomUUID } from "node:crypto";
import type { OutboundMessage } from "./middleware.js";
import type { QueueStore, QueueEntry, QueueStats } from "./queue-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const logger = createSubsystemLogger("redis-queue-store");

export type RedisQueueStoreConfig = {
  url?: string;
  prefix?: string;
  maxAttempts?: number;
};

// Minimal typed interface for Redis methods we use (ioredis is optional)
type RedisPipelineResult = [Error | null, unknown][];
type RedisPipeline = {
  zrem(key: string, member: string): RedisPipeline;
  lpush(key: string, value: string): RedisPipeline;
  hset(key: string, data: string | Record<string, string>): RedisPipeline;
  hgetall(key: string): RedisPipeline;
  srem(key: string, member: string): RedisPipeline;
  del(key: string): RedisPipeline;
  exec(): Promise<RedisPipelineResult>;
};
type RedisClient = {
  once(event: string, cb: (...args: never[]) => void): void;
  script(...args: unknown[]): Promise<string>;
  hset(key: string, data: Record<string, string>): Promise<unknown>;
  lpush(key: string, value: string): Promise<unknown>;
  evalsha(...args: unknown[]): Promise<string[]>;
  hgetall(key: string): Promise<Record<string, string>>;
  srem(key: string, member: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number, max: number): Promise<string[]>;
  smembers(key: string): Promise<string[]>;
  sismember(key: string, member: string): Promise<number>;
  llen(key: string): Promise<number>;
  scard(key: string): Promise<number>;
  pipeline(): RedisPipeline;
  quit(): Promise<unknown>;
};

const DEQUEUE_SCRIPT = `
local pending_key = KEYS[1]
local processing_key = KEYS[2]
local limit = tonumber(ARGV[1])
local ids = {}
for i = 1, limit do
  local id = redis.call('RPOP', pending_key)
  if not id then break end
  redis.call('SADD', processing_key, id)
  ids[#ids + 1] = id
end
return ids
`;

export async function createRedisQueueStore(config: RedisQueueStoreConfig): Promise<QueueStore> {
  const prefix = config.prefix ?? "outbound";
  const maxAttempts = config.maxAttempts ?? 3;

  // Dynamic import of ioredis (optional dependency)
  let RedisConstructor: new (url: string, opts: Record<string, unknown>) => RedisClient;
  try {
    // @ts-expect-error ioredis is an optional dependency
    RedisConstructor = (await import("ioredis")).default;
  } catch (error) {
    throw new Error("Failed to import ioredis. Install it with: pnpm add ioredis", {
      cause: error,
    });
  }

  // Connect to Redis
  const redis = new RedisConstructor(config.url ?? "redis://localhost:6379", {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  // Wait for ready
  await new Promise<void>((resolve, reject) => {
    redis.once("ready", () => {
      logger.info("Redis connected");
      resolve();
    });
    redis.once("error", (err: Error) => {
      logger.error("Redis connection error", { error: err.message });
      reject(err);
    });
  });

  // Load dequeue script
  let dequeueScriptSha: string;
  try {
    dequeueScriptSha = await redis.script("LOAD", DEQUEUE_SCRIPT);
  } catch (error) {
    throw new Error("Failed to load Lua dequeue script", { cause: error });
  }

  // Key builders
  const keys = {
    pending: `${prefix}:pending`,
    processing: `${prefix}:processing`,
    delayed: `${prefix}:delayed`,
    dead: `${prefix}:dead`,
    msg: (id: string) => `${prefix}:msg:${id}`,
  };

  // Sweep timer: move delayed messages back to pending
  const sweepTimer = setInterval(async () => {
    try {
      const now = Date.now();
      const ids = await redis.zrangebyscore(keys.delayed, 0, now);

      if (ids.length > 0) {
        const pipeline = redis.pipeline();
        for (const id of ids) {
          pipeline.zrem(keys.delayed, id);
          pipeline.lpush(keys.pending, id);
          pipeline.hset(keys.msg(id), { status: "pending" });
        }
        await pipeline.exec();
        logger.debug("Swept delayed messages back to pending", {
          count: ids.length,
        });
      }
    } catch (error) {
      logger.error("Error in sweep timer", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, 1000);
  sweepTimer.unref();

  // Helper: parse queue entry from Redis hash
  function parseEntry(hash: Record<string, string>): QueueEntry {
    return {
      id: hash.id,
      message: JSON.parse(hash.message) as OutboundMessage,
      attempts: Number(hash.attempts),
      maxAttempts: Number(hash.maxAttempts),
      createdAt: Number(hash.createdAt),
      nextAttemptAt: Number(hash.nextAttemptAt),
      status: hash.status as "pending" | "processing" | "dead",
      lastError: hash.lastError || undefined,
    };
  }

  // Helper: calculate exponential backoff
  function calculateBackoff(attempts: number): number {
    const baseDelay = 1000; // 1 second
    const delay = baseDelay * Math.pow(2, attempts - 1);
    return Math.min(delay, 60000); // max 1 minute
  }

  return {
    async enqueue(msg: OutboundMessage, id?: string): Promise<string> {
      const messageId = id ?? randomUUID();
      const now = Date.now();

      // Store message hash
      await redis.hset(keys.msg(messageId), {
        id: messageId,
        message: JSON.stringify(msg),
        attempts: "0",
        maxAttempts: String(maxAttempts),
        createdAt: String(now),
        nextAttemptAt: String(now),
        status: "pending",
      });

      // Add to pending list
      await redis.lpush(keys.pending, messageId);

      logger.debug(`enqueued message ${messageId} to ${msg.channel}`);
      return messageId;
    },

    async dequeue(limit: number): Promise<QueueEntry[]> {
      // First, sweep any delayed messages that are ready
      const now = Date.now();
      const readyIds = await redis.zrangebyscore(keys.delayed, 0, now);

      if (readyIds.length > 0) {
        const pipeline = redis.pipeline();
        for (const id of readyIds) {
          pipeline.zrem(keys.delayed, id);
          pipeline.lpush(keys.pending, id);
          pipeline.hset(keys.msg(id), { status: "pending" });
        }
        await pipeline.exec();
      }

      // Dequeue using Lua script for atomicity
      let ids: string[];
      try {
        ids = await redis.evalsha(dequeueScriptSha, 2, keys.pending, keys.processing, limit);
      } catch (error) {
        // Fallback: reload script if NOSCRIPT error
        if (error instanceof Error && error.message.includes("NOSCRIPT")) {
          dequeueScriptSha = await redis.script("LOAD", DEQUEUE_SCRIPT);
          ids = await redis.evalsha(dequeueScriptSha, 2, keys.pending, keys.processing, limit);
        } else {
          throw error;
        }
      }

      if (ids.length === 0) {
        return [];
      }

      // Fetch message hashes
      const pipeline = redis.pipeline();
      for (const id of ids) {
        pipeline.hgetall(keys.msg(id));
      }
      const results = await pipeline.exec();

      const entries: QueueEntry[] = [];
      for (let i = 0; i < ids.length; i++) {
        const [err, hash] = results[i];
        if (err) {
          logger.error("Error fetching message hash", {
            id: ids[i],
            error: err.message,
          });
          continue;
        }

        if (hash && Object.keys(hash).length > 0) {
          const entry = parseEntry(hash as Record<string, string>);

          // Increment attempts and update status
          await redis.hset(keys.msg(entry.id), {
            attempts: String(entry.attempts + 1),
            status: "processing",
          });

          entries.push({ ...entry, attempts: entry.attempts + 1 });
        }
      }

      logger.debug("Dequeued messages", { count: entries.length });
      return entries;
    },

    async complete(id: string): Promise<void> {
      await redis.srem(keys.processing, id);
      await redis.del(keys.msg(id));
      logger.debug("Completed message", { id });
    },

    async fail(id: string, error: string): Promise<void> {
      // Remove from processing
      await redis.srem(keys.processing, id);

      // Get current entry
      const hash = await redis.hgetall(keys.msg(id));
      if (!hash || Object.keys(hash).length === 0) {
        logger.warn("Cannot fail message: not found", { id });
        return;
      }

      const entry = parseEntry(hash);

      if (entry.attempts >= entry.maxAttempts) {
        // Move to dead letter queue
        await redis.sadd(keys.dead, id);
        await redis.hset(keys.msg(id), {
          status: "dead",
          lastError: error,
        });
        logger.warn("Message moved to dead letter queue", {
          id,
          attempts: entry.attempts,
          error,
        });
      } else {
        // Schedule retry with exponential backoff
        const delay = calculateBackoff(entry.attempts);
        const nextAttemptAt = Date.now() + delay;

        await redis.zadd(keys.delayed, nextAttemptAt, id);
        await redis.hset(keys.msg(id), {
          status: "pending",
          nextAttemptAt: String(nextAttemptAt),
          lastError: error,
        });

        logger.debug("Message scheduled for retry", {
          id,
          attempts: entry.attempts,
          delayMs: delay,
          error,
        });
      }
    },

    async deadLetters(limit: number): Promise<QueueEntry[]> {
      const ids = await redis.smembers(keys.dead);
      const limitedIds = ids.slice(0, limit);

      if (limitedIds.length === 0) {
        return [];
      }

      const pipeline = redis.pipeline();
      for (const id of limitedIds) {
        pipeline.hgetall(keys.msg(id));
      }
      const results = await pipeline.exec();

      const entries: QueueEntry[] = [];
      for (let i = 0; i < limitedIds.length; i++) {
        const [err, hash] = results[i];
        if (!err && hash && Object.keys(hash).length > 0) {
          entries.push(parseEntry(hash as Record<string, string>));
        }
      }

      return entries;
    },

    async retryDeadLetter(id: string): Promise<boolean> {
      // Check if in dead queue
      const isDead = await redis.sismember(keys.dead, id);
      if (!isDead) {
        return false;
      }

      // Remove from dead, reset attempts, add back to pending
      const pipeline = redis.pipeline();
      pipeline.srem(keys.dead, id);
      pipeline.hset(keys.msg(id), {
        attempts: "0",
        status: "pending",
        nextAttemptAt: String(Date.now()),
        lastError: "",
      });
      pipeline.lpush(keys.pending, id);
      await pipeline.exec();

      logger.info("Retrying dead letter", { id });
      return true;
    },

    async purgeDeadLetters(): Promise<number> {
      const ids = await redis.smembers(keys.dead);

      if (ids.length === 0) {
        return 0;
      }

      const pipeline = redis.pipeline();
      for (const id of ids) {
        pipeline.del(keys.msg(id));
      }
      pipeline.del(keys.dead);
      await pipeline.exec();

      logger.info("Purged dead letters", { count: ids.length });
      return ids.length;
    },

    async stats(): Promise<QueueStats> {
      const [pending, processing, dead] = await Promise.all([
        redis.llen(keys.pending),
        redis.scard(keys.processing),
        redis.scard(keys.dead),
      ]);

      return { pending, processing, dead };
    },

    async close(): Promise<void> {
      clearInterval(sweepTimer);
      await redis.quit();
      logger.info("Redis queue store closed");
    },
  };
}
