import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OutboundMessage } from "./middleware.js";
import { OutboundQueue } from "./queue.js";

const makeMsg = (text = "hello"): OutboundMessage => ({
  channel: "telegram",
  to: "+1234567890",
  text,
});

describe("OutboundQueue", () => {
  let queue: OutboundQueue;

  beforeEach(() => {
    queue = new OutboundQueue({ dbPath: ":memory:", maxAttempts: 3 });
  });

  afterEach(() => {
    queue.close();
  });

  it("enqueue and dequeue a message", () => {
    const id = queue.enqueue(makeMsg());
    expect(id).toBeTruthy();

    const entries = queue.dequeue(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(id);
    expect(entries[0].message.text).toBe("hello");
    expect(entries[0].status).toBe("processing");
  });

  it("dequeue returns empty when no pending messages", () => {
    expect(queue.dequeue()).toHaveLength(0);
  });

  it("complete removes entry from queue", () => {
    const id = queue.enqueue(makeMsg());
    const [entry] = queue.dequeue();
    queue.complete(entry.id);
    expect(queue.stats().pending).toBe(0);
    expect(queue.stats().processing).toBe(0);
  });

  it("fail increments attempts and re-queues", () => {
    const id = queue.enqueue(makeMsg());
    queue.dequeue();
    queue.fail(id, "network error");

    const stats = queue.stats();
    expect(stats.pending).toBe(1);
    expect(stats.dead).toBe(0);
  });

  it("moves to dead letter after max attempts", () => {
    const id = queue.enqueue(makeMsg());
    for (let i = 0; i < 3; i++) {
      // Reset to pending for next dequeue (simulate time passing)
      queue.dequeue();
      queue.fail(id, `attempt ${i + 1} failed`);
    }

    const stats = queue.stats();
    expect(stats.dead).toBe(1);
    expect(stats.pending).toBe(0);

    const dead = queue.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0].lastError).toContain("attempt 3 failed");
  });

  it("stats returns correct counts", () => {
    queue.enqueue(makeMsg("a"));
    queue.enqueue(makeMsg("b"));
    queue.enqueue(makeMsg("c"));

    expect(queue.stats().pending).toBe(3);

    const entries = queue.dequeue(2);
    expect(queue.stats().processing).toBe(2);
    expect(queue.stats().pending).toBe(1);

    queue.complete(entries[0].id);
    expect(queue.stats().processing).toBe(1);
  });
});
