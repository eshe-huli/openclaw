import type { OutboundMessage, OutboundResult } from "./middleware.js";
import type { QueueStore } from "./queue-store.js";
import type { QueueWorker } from "./queue-worker.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("outbound-bootstrap");

export type OutboundBootstrapConfig = {
  enabled?: boolean;
  store?: string;
  redis?: { url?: string; prefix?: string };
  sqlite?: { path?: string };
  audit?: { enabled?: boolean; path?: string; maxSizeMb?: number };
  maxAttempts?: number;
  pollIntervalMs?: number;
  batchSize?: number;
  visibilityTimeoutMs?: number;
  stateDir?: string;
  queueRetry?: boolean;
};

export type OutboundBootstrapHandle = {
  queue: QueueStore;
  worker: QueueWorker | null;
  close: () => Promise<void>;
};

/**
 * Bootstrap the outbound queue subsystem.
 *
 * Creates the queue store (SQLite/Redis/multi), wires it into the pipeline
 * via `setOutboundQueue`, and optionally starts a background worker.
 */
export async function bootstrapOutboundQueue(
  config: OutboundBootstrapConfig,
  send: (msg: OutboundMessage) => Promise<OutboundResult>,
): Promise<OutboundBootstrapHandle> {
  const { createQueueStore } = await import("./queue-store-factory.js");
  const { setOutboundQueue } = await import("./pipeline.js");
  const { QueueWorker: QueueWorkerClass } = await import("./queue-worker.js");

  const queue = await createQueueStore({
    store: (config.store as "auto" | "sqlite" | "redis" | "multi") ?? "auto",
    redis: config.redis,
    sqlite: config.sqlite,
    audit: config.audit,
    maxAttempts: config.maxAttempts,
    stateDir: config.stateDir,
  });

  // Register the queue so dead-letter gateway endpoints can access it
  setOutboundQueue(queue);

  let worker: QueueWorker | null = null;
  if (config.queueRetry !== false) {
    worker = new QueueWorkerClass(queue, send, {
      pollIntervalMs: config.pollIntervalMs,
      batchSize: config.batchSize,
      visibilityTimeoutMs: config.visibilityTimeoutMs,
    });
    worker.start();
    log.info("outbound queue worker started");
  }

  log.info("outbound queue subsystem initialized");

  return {
    queue,
    worker,
    close: async () => {
      if (worker) {
        await worker.drain();
      }
      await queue.close();
      log.info("outbound queue subsystem shut down");
    },
  };
}
