import type { OutboundMessage, OutboundResult } from "./middleware.js";
import type { OutboundQueue } from "./queue.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("outbound-queue-worker");

export type QueueWorkerConfig = {
  /** How often to poll the queue (ms). Default: 1000. */
  pollIntervalMs?: number;
  /** Max messages to process per poll. Default: 10. */
  batchSize?: number;
};

export class QueueWorker {
  private queue: OutboundQueue;
  private send: (msg: OutboundMessage) => Promise<OutboundResult>;
  private pollIntervalMs: number;
  private batchSize: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    queue: OutboundQueue,
    send: (msg: OutboundMessage) => Promise<OutboundResult>,
    config: QueueWorkerConfig = {},
  ) {
    this.queue = queue;
    this.send = send;
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    this.batchSize = config.batchSize ?? 10;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.processBatch();
    }, this.pollIntervalMs);
    log.info(`queue worker started (poll=${this.pollIntervalMs}ms, batch=${this.batchSize})`);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("queue worker stopped");
  }

  private async processBatch(): Promise<void> {
    const entries = this.queue.dequeue(this.batchSize);
    if (entries.length === 0) return;

    log.debug(`processing ${entries.length} queued messages`);

    for (const entry of entries) {
      try {
        const result = await this.send(entry.message);
        if (result.ok) {
          this.queue.complete(entry.id);
        } else {
          this.queue.fail(entry.id, result.status ?? "delivery returned ok=false");
        }
      } catch (err) {
        this.queue.fail(entry.id, formatErrorMessage(err));
      }
    }
  }
}
