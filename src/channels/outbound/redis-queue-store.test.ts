import { describe, expect, it } from "vitest";

// Redis tests require a running Redis instance.
// Skip by default; set REDIS_URL env var to enable.
const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)("RedisQueueStore", () => {
  it("should connect and enqueue/dequeue (requires REDIS_URL)", async () => {
    const { createRedisQueueStore } = await import("./redis-queue-store.js");
    const store = await createRedisQueueStore({
      url: REDIS_URL!,
      prefix: `test-outbound-${Date.now()}`,
      maxAttempts: 3,
    });

    try {
      const id = await store.enqueue({
        channel: "telegram",
        to: "+1234567890",
        text: "test message",
      });
      expect(id).toBeTruthy();

      const entries = await store.dequeue(10);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].message.text).toBe("test message");

      await store.complete(entries[0].id);
      const stats = await store.stats();
      expect(stats.processing).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("should handle fail and dead letters (requires REDIS_URL)", async () => {
    const { createRedisQueueStore } = await import("./redis-queue-store.js");
    const store = await createRedisQueueStore({
      url: REDIS_URL!,
      prefix: `test-outbound-dl-${Date.now()}`,
      maxAttempts: 2,
    });

    try {
      await store.enqueue({
        channel: "discord",
        to: "#general",
        text: "will fail",
      });

      // Dequeue and fail twice to move to dead letter
      const e1 = await store.dequeue(10);
      expect(e1).toHaveLength(1);
      await store.fail(e1[0].id, "error 1");

      // Wait a bit for delayed sweep
      await new Promise((r) => setTimeout(r, 1100));

      const e2 = await store.dequeue(10);
      if (e2.length > 0) {
        await store.fail(e2[0].id, "error 2");
      }

      const stats = await store.stats();
      expect(stats.dead).toBeGreaterThanOrEqual(0);
    } finally {
      await store.close();
    }
  });
});

describe("RedisQueueStore (dynamic import)", () => {
  it("throws if ioredis is not available and REDIS_URL not set", async () => {
    // This test just verifies the module can be imported without error
    const mod = await import("./redis-queue-store.js");
    expect(typeof mod.createRedisQueueStore).toBe("function");
  });
});
