import type { ChannelId, OutboundMiddleware } from "./middleware.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("outbound-rate-limit");

export type RateLimitConfig = {
  /** Per-channel rates (messages per second). */
  rates?: Partial<Record<ChannelId, number>>;
};

const DEFAULT_RATES: Record<ChannelId, number> = {
  telegram: 30,
  discord: 5,
  slack: 1,
  signal: 10,
  whatsapp: 20,
  line: 10,
  feishu: 10,
  imessage: 10,
};

type Bucket = {
  tokens: number;
  lastRefill: number;
  lastAccess: number;
  rate: number;
};

export function createRateLimitMiddleware(config: RateLimitConfig = {}): OutboundMiddleware {
  const buckets = new Map<string, Bucket>();

  function getBucket(channel: ChannelId, accountId?: string): Bucket {
    const key = accountId ? `${channel}:${accountId}` : channel;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      const rate = config.rates?.[channel] ?? DEFAULT_RATES[channel] ?? 10;
      bucket = { tokens: rate, lastRefill: now, lastAccess: now, rate };
      buckets.set(key, bucket);
    } else {
      bucket.lastAccess = now;
    }
    return bucket;
  }

  function evictStaleBuckets(): void {
    if (buckets.size <= 1000) return;

    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes
    const keysToDelete: string[] = [];

    for (const [key, bucket] of buckets.entries()) {
      if (now - bucket.lastAccess > staleThreshold) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      buckets.delete(key);
    }

    if (keysToDelete.length > 0) {
      log.debug(`evicted ${keysToDelete.length} stale rate limit buckets`);
    }
  }

  function tryConsume(bucket: Bucket): boolean {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(bucket.rate, bucket.tokens + elapsed * bucket.rate);
    bucket.lastRefill = now;
    bucket.lastAccess = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      evictStaleBuckets();
      return true;
    }
    return false;
  }

  return async (msg, next) => {
    const bucket = getBucket(msg.channel, msg.accountId);
    if (!tryConsume(bucket)) {
      const waitMs = Math.ceil(((1 - bucket.tokens) / bucket.rate) * 1000);
      log.debug(`rate limit hit for ${msg.channel}, waiting ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      // Refill after wait
      bucket.tokens = Math.min(bucket.rate, bucket.tokens + (waitMs / 1000) * bucket.rate);
      bucket.tokens -= 1;
    }
    return next(msg);
  };
}
