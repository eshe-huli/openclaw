import type { OutboundMiddleware, OutboundMessage } from "./middleware.js";
import { createDedupeCache, type DedupeCache } from "../../infra/dedupe.js";

export type DedupConfig = {
  ttlMs?: number;
  maxSize?: number;
};

/** FNV-1a 32-bit hash — ~10x faster than SHA-256 for short dedup keys. */
function fnv1a32(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function contentHash(msg: OutboundMessage): string {
  const payload = `${msg.channel}:${msg.accountId ?? ""}:${msg.to}:${msg.text}:${msg.mediaUrl ?? ""}`;
  return fnv1a32(payload);
}

export function createDedupMiddleware(config: DedupConfig = {}): OutboundMiddleware {
  const cache: DedupeCache = createDedupeCache({
    ttlMs: config.ttlMs ?? 10_000,
    maxSize: config.maxSize ?? 2000,
  });

  const middleware: OutboundMiddleware = async (msg, next) => {
    const key = contentHash(msg);
    if (cache.check(key)) {
      return { ok: true, status: "dedup: duplicate suppressed" };
    }
    return next(msg);
  };

  return middleware;
}
