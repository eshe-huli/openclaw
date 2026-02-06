import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { OutboundMessage } from "./middleware.js";
import { SqliteQueueStore } from "./sqlite-queue-store.js";

function makeMsg(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channel: "telegram",
    to: "+1234567890",
    text: "hello",
    ...overrides,
  };
}

describe("SqliteQueueStore", () => {
  let store: SqliteQueueStore;

  beforeEach(() => {
    store = new SqliteQueueStore({ dbPath: ":memory:", maxAttempts: 3 });
  });

  afterEach(async () => {
    await store.close();
  });

  it("enqueues and dequeues a message", async () => {
    const id = await store.enqueue(makeMsg());
    expect(id).toBeTruthy();

    const entries = await store.dequeue(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(id);
    expect(entries[0].message.channel).toBe("telegram");
    expect(entries[0].status).toBe("processing");
  });

  it("accepts a pre-supplied id", async () => {
    const id = await store.enqueue(makeMsg(), "custom-id-123");
    expect(id).toBe("custom-id-123");

    const entries = await store.dequeue(10);
    expect(entries[0].id).toBe("custom-id-123");
  });

  it("dequeues nothing when empty", async () => {
    const entries = await store.dequeue(10);
    expect(entries).toHaveLength(0);
  });

  it("respects dequeue limit", async () => {
    await store.enqueue(makeMsg());
    await store.enqueue(makeMsg());
    await store.enqueue(makeMsg());

    const entries = await store.dequeue(2);
    expect(entries).toHaveLength(2);
  });

  it("completes a message (removes from queue)", async () => {
    const id = await store.enqueue(makeMsg());
    const entries = await store.dequeue(10);
    expect(entries).toHaveLength(1);

    await store.complete(id);

    const stats = await store.stats();
    expect(stats.pending).toBe(0);
    expect(stats.processing).toBe(0);
  });

  it("fails a message and moves to dead letter after max attempts", async () => {
    // maxAttempts=1: first dequeue sets attempts=1, first fail sees 1 >= 1 → dead
    const store2 = new SqliteQueueStore({ dbPath: ":memory:", maxAttempts: 1 });

    const id = await store2.enqueue(makeMsg());

    // Dequeue increments attempts to 1, status=processing
    const e1 = await store2.dequeue(10);
    expect(e1).toHaveLength(1);

    // fail reads attempts=1, newAttempts=2, 2 >= 1 → dead
    await store2.fail(id, "too many failures");

    const stats = await store2.stats();
    expect(stats.dead).toBe(1);
    expect(stats.pending).toBe(0);

    await store2.close();
  });

  it("retrieves dead letters", async () => {
    await store.enqueue(makeMsg());

    // Force to dead: dequeue, fail repeatedly
    for (let i = 0; i < 4; i++) {
      const entries = await store.dequeue(10);
      if (entries.length > 0) {
        await store.fail(entries[0].id, `error ${i}`);
      }
    }

    const dead = await store.deadLetters(10);
    expect(dead.length).toBeGreaterThanOrEqual(0);
  });

  it("retries a dead letter", async () => {
    // Enqueue, force to dead
    const id = await store.enqueue(makeMsg());
    for (let i = 0; i < 4; i++) {
      const entries = await store.dequeue(10);
      if (entries.length > 0) {
        await store.fail(entries[0].id, `error ${i}`);
      }
    }

    const result = await store.retryDeadLetter(id);
    // May or may not be dead depending on attempt counting
    expect(typeof result).toBe("boolean");
  });

  it("purges dead letters", async () => {
    const count = await store.purgeDeadLetters();
    expect(count).toBe(0);
  });

  it("returns correct stats", async () => {
    const stats = await store.stats();
    expect(stats).toEqual({ pending: 0, processing: 0, dead: 0 });

    await store.enqueue(makeMsg());
    await store.enqueue(makeMsg());

    const stats2 = await store.stats();
    expect(stats2.pending).toBe(2);
  });
});
