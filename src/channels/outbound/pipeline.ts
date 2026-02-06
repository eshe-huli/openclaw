import type { QueueStore } from "./queue-store.js";
import { loadConfig } from "../../config/config.js";
import { createCircuitBreakerMiddleware, type CircuitBreakerConfig } from "./circuit-breaker.js";
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
import { createRateLimitMiddleware } from "./rate-limit.js";
import { createRetryMiddleware } from "./retry.js";
import { createValidateMiddleware } from "./validate.js";

export type OutboundConfig = {
  enabled?: boolean;
  dedup?: { ttlMs?: number; maxSize?: number };
  rateLimits?: Partial<Record<ChannelId, number>>;
  retry?: { attempts?: number; minDelayMs?: number; maxDelayMs?: number; jitter?: number };
  /** When true, skip pipeline retry middleware (queue handles retry instead). */
  queueRetry?: boolean;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  store?: string;
  redis?: { url?: string; prefix?: string };
  sqlite?: { path?: string };
  audit?: { enabled?: boolean; path?: string; maxSizeMb?: number };
};

let _metricsHandle: ReturnType<typeof createMetricsMiddleware> | null = null;
let _queue: QueueStore | null = null;

export function getOutboundMetrics(): MetricsSnapshot | null {
  return _metricsHandle?.snapshot() ?? null;
}

export function resetOutboundMetrics(): void {
  _metricsHandle?.reset();
}

export function getOutboundQueue(): QueueStore | null {
  return _queue;
}

export function setOutboundQueue(queue: QueueStore): void {
  _queue = queue;
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
 * Order: log → validate → dedup → metrics → circuit-breaker → rate-limit → [retry] → (send)
 *
 * When queue-based retry is active (`queueRetry: true`), the retry middleware is skipped
 * to avoid double-retry (queue already handles exponential backoff).
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

  // 5. Circuit breaker (reject fast when channel is down)
  stack.push(
    createCircuitBreakerMiddleware({
      failureThreshold: config.circuitBreaker?.failureThreshold,
      resetTimeoutMs: config.circuitBreaker?.resetTimeoutMs,
      windowMs: config.circuitBreaker?.windowMs,
    }),
  );

  // 6. Rate limiting
  stack.push(
    createRateLimitMiddleware({
      rates: config.rateLimits,
    }),
  );

  // 7. Retry (innermost: wraps actual delivery) — skip when queue handles retry
  if (!config.queueRetry) {
    stack.push(
      createRetryMiddleware({
        attempts: config.retry?.attempts,
        minDelayMs: config.retry?.minDelayMs,
        maxDelayMs: config.retry?.maxDelayMs,
        jitter: config.retry?.jitter,
      }),
    );
  }

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
