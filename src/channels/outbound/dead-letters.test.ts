import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OutboundMessage } from "./middleware.js";
import { OutboundQueue } from "./queue.js";

describe("OutboundQueue - Dead Letters", () => {
  let queue: OutboundQueue;

  beforeEach(() => {
    queue = new OutboundQueue({ dbPath: ":memory:", maxAttempts: 3 });
  });

  afterEach(() => {
    queue.close();
  });

  it("should retry a dead letter by resetting status to pending", () => {
    // Enqueue a message
    const msg: OutboundMessage = {
      channel: "telegram",
      to: "123",
      text: "test",
    };
    const id = queue.enqueue(msg);

    // Simulate max failures to move to dead letter
    queue.fail(id, "error 1");
    queue.fail(id, "error 2");
    queue.fail(id, "error 3");

    // Verify it's dead
    const deadBefore = queue.deadLetters(10);
    expect(deadBefore).toHaveLength(1);
    expect(deadBefore[0].id).toBe(id);
    expect(deadBefore[0].status).toBe("dead");
    expect(deadBefore[0].attempts).toBe(3);

    // Retry the dead letter
    const success = queue.retryDeadLetter(id);
    expect(success).toBe(true);

    // Verify it moved back to pending
    const deadAfter = queue.deadLetters(10);
    expect(deadAfter).toHaveLength(0);

    const stats = queue.stats();
    expect(stats.dead).toBe(0);
    expect(stats.pending).toBe(1);

    // Dequeue to verify it's available again
    const pending = queue.dequeue(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id);
    expect(pending[0].attempts).toBe(0); // Reset to 0
    expect(pending[0].lastError).toBeUndefined(); // Cleared
  });

  it("should return false when retrying nonexistent id", () => {
    const success = queue.retryDeadLetter("nonexistent-id");
    expect(success).toBe(false);
  });

  it("should return false when retrying non-dead message", () => {
    const msg: OutboundMessage = {
      channel: "slack",
      to: "456",
      text: "pending message",
    };
    const id = queue.enqueue(msg);

    // Try to retry a pending message
    const success = queue.retryDeadLetter(id);
    expect(success).toBe(false);

    // Verify it's still pending
    const stats = queue.stats();
    expect(stats.pending).toBe(1);
    expect(stats.dead).toBe(0);
  });

  it("should list dead letters with failure details", () => {
    // Create multiple dead letters
    const msg1: OutboundMessage = { channel: "telegram", to: "111", text: "msg1" };
    const msg2: OutboundMessage = { channel: "discord", to: "222", text: "msg2" };

    const id1 = queue.enqueue(msg1);
    const id2 = queue.enqueue(msg2);

    // Move both to dead letter
    for (let i = 0; i < 3; i++) {
      queue.fail(id1, `error ${i + 1} for msg1`);
      queue.fail(id2, `error ${i + 1} for msg2`);
    }

    const deadLetters = queue.deadLetters(10);
    expect(deadLetters).toHaveLength(2);

    // Find each message
    const dead1 = deadLetters.find((d) => d.id === id1);
    const dead2 = deadLetters.find((d) => d.id === id2);

    expect(dead1).toBeDefined();
    expect(dead1?.status).toBe("dead");
    expect(dead1?.attempts).toBe(3);
    expect(dead1?.lastError).toBe("error 3 for msg1");
    expect(dead1?.message.channel).toBe("telegram");

    expect(dead2).toBeDefined();
    expect(dead2?.status).toBe("dead");
    expect(dead2?.attempts).toBe(3);
    expect(dead2?.lastError).toBe("error 3 for msg2");
    expect(dead2?.message.channel).toBe("discord");
  });

  it("should respect limit parameter when listing dead letters", () => {
    // Create 5 dead letters
    for (let i = 0; i < 5; i++) {
      const msg: OutboundMessage = { channel: "slack", to: `user${i}`, text: `msg${i}` };
      const id = queue.enqueue(msg);
      for (let j = 0; j < 3; j++) {
        queue.fail(id, `error ${j}`);
      }
    }

    // Request only 3
    const limited = queue.deadLetters(3);
    expect(limited).toHaveLength(3);

    // Request all
    const all = queue.deadLetters(10);
    expect(all).toHaveLength(5);
  });

  it("should purge all dead letters", () => {
    // Create some dead letters and a pending one
    const msg1: OutboundMessage = { channel: "telegram", to: "111", text: "dead1" };
    const msg2: OutboundMessage = { channel: "discord", to: "222", text: "dead2" };
    const msg3: OutboundMessage = { channel: "slack", to: "333", text: "pending" };

    const id1 = queue.enqueue(msg1);
    const id2 = queue.enqueue(msg2);
    const id3 = queue.enqueue(msg3);

    // Move first two to dead
    for (let i = 0; i < 3; i++) {
      queue.fail(id1, `error ${i}`);
      queue.fail(id2, `error ${i}`);
    }

    // Verify initial state
    let stats = queue.stats();
    expect(stats.dead).toBe(2);
    expect(stats.pending).toBe(1);

    // Purge dead letters
    const deleted = queue.purgeDeadLetters();
    expect(deleted).toBe(2);

    // Verify only pending remains
    stats = queue.stats();
    expect(stats.dead).toBe(0);
    expect(stats.pending).toBe(1);

    const deadLetters = queue.deadLetters(10);
    expect(deadLetters).toHaveLength(0);

    const pending = queue.dequeue(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id3);
  });

  it("should return 0 when purging with no dead letters", () => {
    const msg: OutboundMessage = { channel: "telegram", to: "123", text: "test" };
    queue.enqueue(msg);

    const deleted = queue.purgeDeadLetters();
    expect(deleted).toBe(0);

    const stats = queue.stats();
    expect(stats.pending).toBe(1);
    expect(stats.dead).toBe(0);
  });
});
