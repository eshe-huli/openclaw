import { describe, expect, it, vi } from "vitest";
import type { OutboundMessage } from "./middleware.js";
import type { QueueStore, QueueEntry } from "./queue-store.js";
import { MultiBackendQueue } from "./multi-backend-queue.js";

function makeMsg(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channel: "telegram",
    to: "+1234567890",
    text: "hello",
    ...overrides,
  };
}

type MockFns = {
  enqueue: ReturnType<typeof vi.fn>;
  dequeue: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  deadLetters: ReturnType<typeof vi.fn>;
  retryDeadLetter: ReturnType<typeof vi.fn>;
  purgeDeadLetters: ReturnType<typeof vi.fn>;
  stats: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function makeMockStore(overrides: Partial<MockFns> = {}): { store: QueueStore; fns: MockFns } {
  const fns: MockFns = {
    enqueue: overrides.enqueue ?? vi.fn().mockResolvedValue("mock-id"),
    dequeue: overrides.dequeue ?? vi.fn().mockResolvedValue([]),
    complete: overrides.complete ?? vi.fn().mockResolvedValue(undefined),
    fail: overrides.fail ?? vi.fn().mockResolvedValue(undefined),
    deadLetters: overrides.deadLetters ?? vi.fn().mockResolvedValue([]),
    retryDeadLetter: overrides.retryDeadLetter ?? vi.fn().mockResolvedValue(false),
    purgeDeadLetters: overrides.purgeDeadLetters ?? vi.fn().mockResolvedValue(0),
    stats: overrides.stats ?? vi.fn().mockResolvedValue({ pending: 0, processing: 0, dead: 0 }),
    close: overrides.close ?? vi.fn().mockResolvedValue(undefined),
  };
  return { store: fns as unknown as QueueStore, fns };
}

describe("MultiBackendQueue", () => {
  it("throws when created with no stores", () => {
    expect(() => new MultiBackendQueue([])).toThrow("at least one store");
  });

  it("enqueues to all active stores", async () => {
    const m1 = makeMockStore();
    const m2 = makeMockStore();
    const queue = new MultiBackendQueue([m1.store, m2.store]);

    const id = await queue.enqueue(makeMsg());
    expect(id).toBeTruthy();
    expect(m1.fns.enqueue).toHaveBeenCalled();
    expect(m2.fns.enqueue).toHaveBeenCalled();
  });

  it("uses pre-supplied id for enqueue", async () => {
    const m1 = makeMockStore();
    const queue = new MultiBackendQueue([m1.store]);

    const id = await queue.enqueue(makeMsg(), "my-custom-id");
    expect(id).toBe("my-custom-id");
  });

  it("succeeds if at least one store enqueue succeeds", async () => {
    const m1 = makeMockStore({ enqueue: vi.fn().mockRejectedValue(new Error("s1 down")) });
    const m2 = makeMockStore();
    const queue = new MultiBackendQueue([m1.store, m2.store]);

    const id = await queue.enqueue(makeMsg());
    expect(id).toBeTruthy();
  });

  it("throws if all stores fail to enqueue", async () => {
    const m1 = makeMockStore({ enqueue: vi.fn().mockRejectedValue(new Error("s1 down")) });
    const m2 = makeMockStore({ enqueue: vi.fn().mockRejectedValue(new Error("s2 down")) });
    const queue = new MultiBackendQueue([m1.store, m2.store]);

    await expect(queue.enqueue(makeMsg())).rejects.toThrow("All backends failed");
  });

  it("dequeues from the fastest store", async () => {
    const entry: QueueEntry = {
      id: "e1",
      message: makeMsg(),
      attempts: 1,
      maxAttempts: 3,
      createdAt: Date.now(),
      nextAttemptAt: Date.now(),
      status: "processing",
    };

    const m1 = makeMockStore({
      dequeue: vi
        .fn()
        .mockImplementation(() => new Promise((r) => setTimeout(() => r([entry]), 100))),
    });
    const m2 = makeMockStore({
      dequeue: vi.fn().mockResolvedValue([entry]),
    });
    const queue = new MultiBackendQueue([m1.store, m2.store]);

    const entries = await queue.dequeue(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("e1");
  });

  it("returns empty on dequeue if all stores fail", async () => {
    const m1 = makeMockStore({ dequeue: vi.fn().mockRejectedValue(new Error("fail")) });
    const queue = new MultiBackendQueue([m1.store]);

    const entries = await queue.dequeue(10);
    expect(entries).toHaveLength(0);
  });

  it("fans out complete to all stores", async () => {
    const m1 = makeMockStore();
    const m2 = makeMockStore();
    const queue = new MultiBackendQueue([m1.store, m2.store]);

    await queue.complete("id-1");
    expect(m1.fns.complete).toHaveBeenCalledWith("id-1");
    expect(m2.fns.complete).toHaveBeenCalledWith("id-1");
  });

  it("fans out fail to all stores", async () => {
    const m1 = makeMockStore();
    const m2 = makeMockStore();
    const queue = new MultiBackendQueue([m1.store, m2.store]);

    await queue.fail("id-1", "test error");
    expect(m1.fns.fail).toHaveBeenCalledWith("id-1", "test error");
    expect(m2.fns.fail).toHaveBeenCalledWith("id-1", "test error");
  });

  it("returns stats from first responding store", async () => {
    const m1 = makeMockStore({
      stats: vi.fn().mockResolvedValue({ pending: 5, processing: 2, dead: 1 }),
    });
    const queue = new MultiBackendQueue([m1.store]);

    const stats = await queue.stats();
    expect(stats).toEqual({ pending: 5, processing: 2, dead: 1 });
  });

  it("degrades stores after consecutive failures", async () => {
    const m1 = makeMockStore({
      enqueue: vi.fn().mockRejectedValue(new Error("always fails")),
    });
    const m2 = makeMockStore();
    const queue = new MultiBackendQueue([m1.store, m2.store]);

    // 3 failures should disable m1
    for (let i = 0; i < 3; i++) {
      await queue.enqueue(makeMsg());
    }

    // m2 should still work
    const id = await queue.enqueue(makeMsg());
    expect(id).toBeTruthy();
  });

  it("closes all stores", async () => {
    const m1 = makeMockStore();
    const m2 = makeMockStore();
    const queue = new MultiBackendQueue([m1.store, m2.store]);

    await queue.close();
    expect(m1.fns.close).toHaveBeenCalled();
    expect(m2.fns.close).toHaveBeenCalled();
  });

  it("retryDeadLetter returns true if any store succeeds", async () => {
    const m1 = makeMockStore({ retryDeadLetter: vi.fn().mockResolvedValue(true) });
    const m2 = makeMockStore({ retryDeadLetter: vi.fn().mockResolvedValue(false) });
    const queue = new MultiBackendQueue([m1.store, m2.store]);

    const result = await queue.retryDeadLetter("dead-1");
    expect(result).toBe(true);
  });

  it("purgeDeadLetters returns max count from stores", async () => {
    const m1 = makeMockStore({ purgeDeadLetters: vi.fn().mockResolvedValue(3) });
    const m2 = makeMockStore({ purgeDeadLetters: vi.fn().mockResolvedValue(5) });
    const queue = new MultiBackendQueue([m1.store, m2.store]);

    const count = await queue.purgeDeadLetters();
    expect(count).toBe(5);
  });
});
