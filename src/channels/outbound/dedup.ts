import { createHash } from "node:crypto";
import type { OutboundMiddleware, OutboundMessage } from "./middleware.js";
import { createDedupeCache, type DedupeCache } from "../../infra/dedupe.js";

export type DedupConfig = {
  ttlMs?: number;
  maxSize?: number;
};

function contentHash(msg: OutboundMessage): string {
  const payload = `${msg.channel}:${msg.accountId ?? ""}:${msg.to}:${msg.text}:${msg.mediaUrl ?? ""}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
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
