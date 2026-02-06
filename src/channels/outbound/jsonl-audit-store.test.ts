import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { JsonlAuditStore } from "./jsonl-audit-store.js";

function tmpPath(name: string): string {
  const dir = join(tmpdir(), "openclaw-test-audit");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}-${Date.now()}.jsonl`);
}

function cleanup(path: string): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // ignore
  }
}

describe("JsonlAuditStore", () => {
  const paths: string[] = [];

  afterEach(async () => {
    for (const p of paths) {
      cleanup(p);
    }
    paths.length = 0;
  });

  it("writes JSONL entries to file", async () => {
    const path = tmpPath("write");
    paths.push(path);
    const store = new JsonlAuditStore({ path });

    store.write({ ts: 1000, op: "enqueue", id: "msg-1", channel: "telegram" });
    store.write({ ts: 2000, op: "complete", id: "msg-1" });

    await store.close();

    const content = readFileSync(path, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const entry1 = JSON.parse(lines[0]);
    expect(entry1.op).toBe("enqueue");
    expect(entry1.id).toBe("msg-1");
    expect(entry1.channel).toBe("telegram");

    const entry2 = JSON.parse(lines[1]);
    expect(entry2.op).toBe("complete");
  });

  it("write is fire-and-forget (never throws)", async () => {
    const path = tmpPath("no-throw");
    paths.push(path);
    const store = new JsonlAuditStore({ path });

    // This should not throw even with unusual data
    expect(() => {
      store.write({ ts: Date.now(), op: "enqueue", id: "test" });
    }).not.toThrow();

    await store.close();
  });

  it("rotates file when maxSizeMb exceeded", async () => {
    const path = tmpPath("rotate");
    paths.push(path);
    // Very small max size to trigger rotation quickly
    const store = new JsonlAuditStore({ path, maxSizeMb: 0.0001 });

    // Write more than 100 entries to trigger rotation check
    for (let i = 0; i < 110; i++) {
      store.write({ ts: Date.now(), op: "enqueue", id: `msg-${i}`, channel: "slack" });
    }

    // Give a tiny bit of time for async write stream operations
    await new Promise((r) => setTimeout(r, 100));
    await store.close();

    // File should still exist (new one after rotation)
    expect(existsSync(path)).toBe(true);
  });

  it("handles all operation types", async () => {
    const path = tmpPath("ops");
    paths.push(path);
    const store = new JsonlAuditStore({ path });

    store.write({ ts: 1, op: "enqueue", id: "1" });
    store.write({ ts: 2, op: "dequeue", id: "1" });
    store.write({ ts: 3, op: "complete", id: "1" });
    store.write({ ts: 4, op: "fail", id: "2", error: "timeout" });
    store.write({ ts: 5, op: "retry", id: "2" });
    store.write({ ts: 6, op: "purge", id: "*" });

    await store.close();

    const content = readFileSync(path, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(6);
  });
});
