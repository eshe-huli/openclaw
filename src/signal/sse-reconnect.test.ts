import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to mock the dependencies
vi.mock("./client.js", () => ({
  streamSignalEvents: vi.fn(),
}));

vi.mock("../globals.js", () => ({
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
}));

import { streamSignalEvents } from "./client.js";
import { runSignalSseLoop } from "./sse-reconnect.js";

describe("runSignalSseLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stops after maxAttempts reconnects", async () => {
    const mockStream = vi.mocked(streamSignalEvents);
    mockStream.mockRejectedValue(new Error("connection failed"));

    const errors: string[] = [];
    const logs: string[] = [];
    const runtime = {
      error: (msg: string) => errors.push(msg),
      log: (msg: string) => logs.push(msg),
    };

    const loopPromise = runSignalSseLoop({
      baseUrl: "http://localhost:1234",
      runtime,
      onEvent: () => {},
      policy: { maxAttempts: 3 },
    });

    // Advance through 3 backoff delays
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await loopPromise;

    expect(mockStream).toHaveBeenCalledTimes(3);
    expect(errors.some((e) => e.includes("reconnect limit reached"))).toBe(true);
  });

  it("retries indefinitely when maxAttempts is 0", async () => {
    const controller = new AbortController();
    const mockStream = vi.mocked(streamSignalEvents);
    let callCount = 0;
    mockStream.mockImplementation(async () => {
      callCount++;
      if (callCount >= 5) {
        controller.abort();
      }
      throw new Error("connection failed");
    });

    const runtime = {
      error: () => {},
      log: () => {},
    };

    const loopPromise = runSignalSseLoop({
      baseUrl: "http://localhost:1234",
      abortSignal: controller.signal,
      runtime,
      onEvent: () => {},
      policy: { maxAttempts: 0 },
    });

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }

    await loopPromise;

    expect(callCount).toBeGreaterThanOrEqual(5);
  });
});
