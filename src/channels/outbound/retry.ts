import type { OutboundMiddleware } from "./middleware.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { retryAsync, type RetryConfig } from "../../infra/retry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("outbound-retry");

export type OutboundRetryConfig = RetryConfig;

export function createRetryMiddleware(config: OutboundRetryConfig = {}): OutboundMiddleware {
  return async (msg, next) => {
    return retryAsync(() => next(msg), {
      attempts: config.attempts ?? 3,
      minDelayMs: config.minDelayMs ?? 500,
      maxDelayMs: config.maxDelayMs ?? 30_000,
      jitter: config.jitter ?? 0.1,
      label: `outbound:${msg.channel}`,
      onRetry: (info) => {
        log.debug(
          `retrying ${msg.channel} send to=${msg.to} attempt=${info.attempt}/${info.maxAttempts}: ${formatErrorMessage(info.err)}`,
        );
      },
    });
  };
}
