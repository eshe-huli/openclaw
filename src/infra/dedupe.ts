export type DedupeCache = {
  check: (key: string | undefined | null, now?: number) => boolean;
  clear: () => void;
  size: () => number;
};

type DedupeCacheOptions = {
  ttlMs: number;
  maxSize: number;
};

export function createDedupeCache(options: DedupeCacheOptions): DedupeCache {
  const ttlMs = Math.max(0, options.ttlMs);
  const maxSize = Math.max(0, Math.floor(options.maxSize));
  const cache = new Map<string, number>();
  let pruneTimer: ReturnType<typeof setInterval> | null = null;

  const touch = (key: string, now: number) => {
    cache.delete(key);
    cache.set(key, now);
  };

  const pruneTtl = (now: number) => {
    const cutoff = ttlMs > 0 ? now - ttlMs : undefined;
    if (cutoff !== undefined) {
      for (const [entryKey, entryTs] of cache) {
        if (entryTs < cutoff) {
          cache.delete(entryKey);
        }
      }
    }
  };

  const pruneSize = () => {
    if (maxSize <= 0) {
      cache.clear();
      return;
    }
    while (cache.size > maxSize) {
      const oldestKey = cache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      cache.delete(oldestKey);
    }
  };

  /** Lazy-start the background prune timer on first check(). */
  const ensurePruneTimer = () => {
    if (pruneTimer) {
      return;
    }
    const interval = Math.max(1000, Math.floor(ttlMs / 2));
    pruneTimer = setInterval(() => {
      pruneTtl(Date.now());
      pruneSize();
    }, interval);
    pruneTimer.unref();
  };

  return {
    check: (key, now = Date.now()) => {
      if (!key) {
        return false;
      }
      ensurePruneTimer();
      const existing = cache.get(key);
      if (existing !== undefined && (ttlMs <= 0 || now - existing < ttlMs)) {
        touch(key, now);
        return true;
      }
      touch(key, now);
      pruneTtl(now);
      pruneSize();
      return false;
    },
    clear: () => {
      cache.clear();
      if (pruneTimer) {
        clearInterval(pruneTimer);
        pruneTimer = null;
      }
    },
    size: () => cache.size,
  };
}
