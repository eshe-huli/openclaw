import { randomUUID } from "node:crypto";
import type { JsonlAuditStore } from "./jsonl-audit-store.js";
import type { OutboundMessage } from "./middleware.js";
import type { QueueEntry, QueueStats, QueueStore } from "./queue-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("multi-backend-queue");

type StoreHealth = {
  consecutiveFailures: number;
  disabledUntil: number;
};

const MAX_CONSECUTIVE_FAILURES = 3;
const DISABLE_DURATION_MS = 60_000;

/**
 * Multi-backend queue orchestrator.
 *
 * - **Write (enqueue):** `Promise.allSettled()` to all stores, resolve when first succeeds.
 * - **Read (dequeue):** `Promise.race()` — take the fastest responding store.
 * - **Complete/fail:** fan out to all stores.
 * - **Audit:** fire-and-forget JSONL on every operation.
 * - **Degradation:** after 3 consecutive failures, skip store for 60s, probe with `stats()`.
 */
export class MultiBackendQueue implements QueueStore {
  private stores: QueueStore[];
  private audit: JsonlAuditStore | null;
  private health: Map<QueueStore, StoreHealth> = new Map();

  constructor(stores: QueueStore[], audit: JsonlAuditStore | null = null) {
    if (stores.length === 0) {
      throw new Error("MultiBackendQueue requires at least one store");
    }
    this.stores = stores;
    this.audit = audit;
    for (const store of stores) {
      this.health.set(store, { consecutiveFailures: 0, disabledUntil: 0 });
    }
  }

  private activeStores(): QueueStore[] {
    const now = Date.now();
    const active = this.stores.filter((s) => {
      const h = this.health.get(s)!;
      return h.disabledUntil <= now;
    });
    // If all stores disabled, try them all (last resort)
    return active.length > 0 ? active : this.stores;
  }

  private recordSuccess(store: QueueStore): void {
    const h = this.health.get(store);
    if (h) {
      h.consecutiveFailures = 0;
      h.disabledUntil = 0;
    }
  }

  private recordFailure(store: QueueStore): void {
    const h = this.health.get(store);
    if (!h) {
      return;
    }
    h.consecutiveFailures++;
    if (h.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      h.disabledUntil = Date.now() + DISABLE_DURATION_MS;
      log.warn(
        `store disabled for ${DISABLE_DURATION_MS}ms after ${h.consecutiveFailures} failures`,
      );
    }
  }

  async enqueue(msg: OutboundMessage, id?: string): Promise<string> {
    const entryId = id ?? randomUUID();
    this.audit?.write({
      ts: Date.now(),
      op: "enqueue",
      id: entryId,
      channel: msg.channel,
      to: msg.to,
    });

    const stores = this.activeStores();
    const results = await Promise.allSettled(
      stores.map(async (store) => {
        try {
          const result = await store.enqueue(msg, entryId);
          this.recordSuccess(store);
          return result;
        } catch (err) {
          this.recordFailure(store);
          throw err;
        }
      }),
    );

    if (results.every((r) => r.status === "rejected")) {
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => String(r.reason));
      throw new Error(`All backends failed to enqueue: ${errors.join("; ")}`);
    }
    return entryId;
  }

  async dequeue(limit: number): Promise<QueueEntry[]> {
    const stores = this.activeStores();

    // Race: take the fastest store that returns entries
    const result = await Promise.race(
      stores.map(async (store) => {
        try {
          const entries = await store.dequeue(limit);
          this.recordSuccess(store);
          return entries;
        } catch {
          this.recordFailure(store);
          return [] as QueueEntry[];
        }
      }),
    );

    for (const entry of result) {
      this.audit?.write({ ts: Date.now(), op: "dequeue", id: entry.id });
    }

    return result;
  }

  async complete(id: string): Promise<void> {
    this.audit?.write({ ts: Date.now(), op: "complete", id });
    const stores = this.activeStores();
    await Promise.allSettled(
      stores.map(async (store) => {
        try {
          await store.complete(id);
          this.recordSuccess(store);
        } catch {
          this.recordFailure(store);
        }
      }),
    );
  }

  async fail(id: string, error: string): Promise<void> {
    this.audit?.write({ ts: Date.now(), op: "fail", id, error });
    const stores = this.activeStores();
    await Promise.allSettled(
      stores.map(async (store) => {
        try {
          await store.fail(id, error);
          this.recordSuccess(store);
        } catch {
          this.recordFailure(store);
        }
      }),
    );
  }

  async deadLetters(limit: number): Promise<QueueEntry[]> {
    const stores = this.activeStores();
    // Return from first store that responds
    for (const store of stores) {
      try {
        const entries = await store.deadLetters(limit);
        this.recordSuccess(store);
        return entries;
      } catch {
        this.recordFailure(store);
      }
    }
    return [];
  }

  async retryDeadLetter(id: string): Promise<boolean> {
    this.audit?.write({ ts: Date.now(), op: "retry", id });
    const stores = this.activeStores();
    const results = await Promise.allSettled(stores.map((s) => s.retryDeadLetter(id)));
    return results.some((r) => r.status === "fulfilled" && r.value);
  }

  async purgeDeadLetters(): Promise<number> {
    this.audit?.write({ ts: Date.now(), op: "purge", id: "*" });
    const stores = this.activeStores();
    const results = await Promise.allSettled(stores.map((s) => s.purgeDeadLetters()));
    // Return max count from any store
    let maxPurged = 0;
    for (const r of results) {
      if (r.status === "fulfilled" && r.value > maxPurged) {
        maxPurged = r.value;
      }
    }
    return maxPurged;
  }

  async stats(): Promise<QueueStats> {
    const stores = this.activeStores();
    // Return from first store that responds
    for (const store of stores) {
      try {
        const s = await store.stats();
        this.recordSuccess(store);
        return s;
      } catch {
        this.recordFailure(store);
      }
    }
    return { pending: 0, processing: 0, dead: 0 };
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.stores.map((s) => s.close()));
    await this.audit?.close();
  }
}
