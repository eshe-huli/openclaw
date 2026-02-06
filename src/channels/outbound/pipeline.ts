import { loadConfig } from "../../config/config.js";
import { createDedupMiddleware } from "./dedup.js";
import { createLogMiddleware } from "./log.js";
import { createMetricsMiddleware, type MetricsSnapshot } from "./metrics.js";
import {
  composeMiddleware,
  type ChannelId,
  type OutboundMessage,
  type OutboundMiddleware,
  type OutboundResult,
} from "./middleware.js";
import { OutboundQueue } from "./queue.js";
import { createRateLimitMiddleware } from "./rate-limit.js";
import { createRetryMiddleware } from "./retry.js";
import { createValidateMiddleware } from "./validate.js";

export type OutboundConfig = {
  enabled?: boolean;
  dedup?: { ttlMs?: number; maxSize?: number };
  rateLimits?: Partial<Record<ChannelId, number>>;
  retry?: { attempts?: number; minDelayMs?: number; maxDelayMs?: number; jitter?: number };
};

let _metricsHandle: ReturnType<typeof createMetricsMiddleware> | null = null;
let _queue: OutboundQueue | null = null;

export function getOutboundMetrics(): MetricsSnapshot | null {
  return _metricsHandle?.snapshot() ?? null;
}

export function resetOutboundMetrics(): void {
  _metricsHandle?.reset();
}

export function getOutboundQueue(): OutboundQueue {
  if (!_queue) {
    _queue = new OutboundQueue({ dbPath: ":memory:" });
  }
  return _queue;
}

function resolveOutboundConfig(): OutboundConfig {
  try {
    const cfg = loadConfig() as Record<string, unknown>;
    const outbound = cfg.outbound;
    if (outbound && typeof outbound === "object") {
      return outbound as OutboundConfig;
    }
  } catch {
    // config not yet loaded, use defaults
  }
  return {};
}

/**
 * Build the default middleware stack from config.
 * Order: log → validate → dedup → rate-limit → retry → (send)
 */
function buildMiddlewareStack(config: OutboundConfig): OutboundMiddleware[] {
  const stack: OutboundMiddleware[] = [];

  // 1. Structured logging (outermost: sees everything)
  stack.push(createLogMiddleware());

  // 2. Validation (fail fast for empty messages)
  stack.push(createValidateMiddleware());

  // 3. Deduplication
  stack.push(
    createDedupMiddleware({
      ttlMs: config.dedup?.ttlMs,
      maxSize: config.dedup?.maxSize,
    }),
  );

  // 4. Metrics tracking
  if (!_metricsHandle) {
    _metricsHandle = createMetricsMiddleware();
  }
  stack.push(_metricsHandle.middleware);

  // 5. Rate limiting
  stack.push(
    createRateLimitMiddleware({
      rates: config.rateLimits,
    }),
  );

  // 6. Retry (innermost: wraps actual delivery)
  stack.push(
    createRetryMiddleware({
      attempts: config.retry?.attempts,
      minDelayMs: config.retry?.minDelayMs,
      maxDelayMs: config.retry?.maxDelayMs,
      jitter: config.retry?.jitter,
    }),
  );

  return stack;
}

/**
 * Create a wrapped send function with middleware pipeline applied.
 *
 * @param channel - The channel identifier
 * @param send - The original channel send function adapted to OutboundMessage → OutboundResult
 * @returns A wrapped function that runs the middleware pipeline before delivery
 */
export function createOutboundPipeline(
  channel: ChannelId,
  send: (msg: OutboundMessage) => Promise<OutboundResult>,
): (msg: OutboundMessage) => Promise<OutboundResult> {
  const config = resolveOutboundConfig();
  if (config.enabled === false) {
    return send;
  }
  const stack = buildMiddlewareStack(config);
  return composeMiddleware(stack, send);
}
