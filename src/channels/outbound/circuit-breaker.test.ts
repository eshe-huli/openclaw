import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OutboundMessage, OutboundResult } from "./middleware.js";
import { createInspectableCircuitBreakerMiddleware } from "./circuit-breaker.js";

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createMessage = (channel = "slack" as const, to = "user1"): OutboundMessage => ({
    channel,
    to,
    text: "test message",
  });

  const createSuccessResult = (message: OutboundMessage): OutboundResult => ({
    messageId: "msg-123",
    channel: message.channel,
    to: message.to,
    success: true,
    timestamp: Date.now(),
  });

  const createFailureResult = (message: OutboundMessage): OutboundResult => ({
    channel: message.channel,
    to: message.to,
    success: false,
    error: "Service error",
    timestamp: Date.now(),
  });

  describe("CLOSED state", () => {
    it("passes through when circuit is closed", async () => {
      const { middleware } = createInspectableCircuitBreakerMiddleware();
      const message = createMessage();
      const expectedResult = createSuccessResult(message);

      const next = vi.fn().mockResolvedValue(expectedResult);

      const result = await middleware(message, next);

      expect(next).toHaveBeenCalledWith(message);
      expect(result).toEqual(expectedResult);
    });

    it("tracks failures but stays closed below threshold", async () => {
      const { middleware, getState } = createInspectableCircuitBreakerMiddleware({
        failureThreshold: 5,
      });
      const message = createMessage();

      const next = vi.fn().mockResolvedValue(createFailureResult(message));

      // Send 4 failures (below threshold of 5)
      for (let i = 0; i < 4; i++) {
        await middleware(message, next);
      }

      expect(getState("slack")).toBe("CLOSED");
      expect(next).toHaveBeenCalledTimes(4);
    });
  });

  describe("OPEN state", () => {
    it("opens circuit after threshold failures", async () => {
      const { middleware, getState } = createInspectableCircuitBreakerMiddleware({
        failureThreshold: 5,
      });
      const message = createMessage();

      const next = vi.fn().mockResolvedValue(createFailureResult(message));

      // Send 5 failures to trigger circuit open
      for (let i = 0; i < 5; i++) {
        await middleware(message, next);
      }

      expect(getState("slack")).toBe("OPEN");
    });

    it("rejects immediately when circuit is open", async () => {
      const { middleware, getState } = createInspectableCircuitBreakerMiddleware({
        failureThreshold: 3,
      });
      const message = createMessage();

      const next = vi.fn().mockResolvedValue(createFailureResult(message));

      // Trigger circuit open
      for (let i = 0; i < 3; i++) {
        await middleware(message, next);
      }

      expect(getState("slack")).toBe("OPEN");
      expect(next).toHaveBeenCalledTimes(3);

      // Next call should not invoke next()
      const result = await middleware(message, next);

      expect(next).toHaveBeenCalledTimes(3); // Still 3, not 4
      expect(result.success).toBe(false);
      expect(result.error).toContain("Circuit breaker open");
    });
  });

  describe("HALF_OPEN state", () => {
    it("transitions to half-open after reset timeout", async () => {
      const { middleware, getState } = createInspectableCircuitBreakerMiddleware({
        failureThreshold: 3,
        resetTimeoutMs: 60000,
      });
      const message = createMessage();

      const next = vi.fn().mockResolvedValue(createFailureResult(message));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await middleware(message, next);
      }

      expect(getState("slack")).toBe("OPEN");

      // Advance time to trigger reset
      vi.advanceTimersByTime(60000);

      expect(getState("slack")).toBe("HALF_OPEN");
    });

    it("closes circuit on successful probe", async () => {
      const { middleware, getState } = createInspectableCircuitBreakerMiddleware({
        failureThreshold: 3,
        resetTimeoutMs: 60000,
      });
      const message = createMessage();

      const next = vi
        .fn()
        .mockResolvedValueOnce(createFailureResult(message))
        .mockResolvedValueOnce(createFailureResult(message))
        .mockResolvedValueOnce(createFailureResult(message))
        .mockResolvedValueOnce(createSuccessResult(message));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await middleware(message, next);
      }

      expect(getState("slack")).toBe("OPEN");

      // Advance time to half-open
      vi.advanceTimersByTime(60000);
      expect(getState("slack")).toBe("HALF_OPEN");

      // Successful probe should close the circuit
      const result = await middleware(message, next);

      expect(result.success).toBe(true);
      expect(getState("slack")).toBe("CLOSED");
    });

    it("re-opens on failed probe", async () => {
      const { middleware, getState } = createInspectableCircuitBreakerMiddleware({
        failureThreshold: 3,
        resetTimeoutMs: 60000,
      });
      const message = createMessage();

      const next = vi.fn().mockResolvedValue(createFailureResult(message));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await middleware(message, next);
      }

      expect(getState("slack")).toBe("OPEN");

      // Advance time to half-open
      vi.advanceTimersByTime(60000);
      expect(getState("slack")).toBe("HALF_OPEN");

      // Failed probe should re-open the circuit
      const result = await middleware(message, next);

      expect(result.success).toBe(false);
      expect(getState("slack")).toBe("OPEN");
    });

    it("allows only one probe request at a time", async () => {
      const { middleware, getState } = createInspectableCircuitBreakerMiddleware({
        failureThreshold: 3,
        resetTimeoutMs: 60000,
      });
      const message = createMessage();

      const next = vi.fn().mockResolvedValue(createFailureResult(message));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await middleware(message, next);
      }

      // Advance time to half-open
      vi.advanceTimersByTime(60000);
      expect(getState("slack")).toBe("HALF_OPEN");

      const callCount = next.mock.calls.length;

      // First probe request should be allowed
      const probe1Promise = middleware(message, next);

      // Second probe request should be rejected immediately
      const result2 = await middleware(message, next);

      expect(result2.success).toBe(false);
      expect(result2.error).toContain("probe in progress");
      expect(next).toHaveBeenCalledTimes(callCount + 1); // Only one additional call

      await probe1Promise;
    });
  });

  describe("per-channel tracking", () => {
    it("tracks per-channel independently", async () => {
      const { middleware, getState } = createInspectableCircuitBreakerMiddleware({
        failureThreshold: 3,
      });

      const slackMessage = createMessage("slack");
      const discordMessage = createMessage("discord");

      const slackNext = vi.fn().mockResolvedValue(createFailureResult(slackMessage));
      const discordNext = vi.fn().mockResolvedValue(createSuccessResult(discordMessage));

      // Fail slack channel
      for (let i = 0; i < 3; i++) {
        await middleware(slackMessage, slackNext);
      }

      // Succeed on discord channel
      await middleware(discordMessage, discordNext);

      expect(getState("slack")).toBe("OPEN");
      expect(getState("discord")).toBe("CLOSED");

      // Slack should be rejected
      const slackResult = await middleware(slackMessage, slackNext);
      expect(slackResult.success).toBe(false);
      expect(slackResult.error).toContain("Circuit breaker open");

      // Discord should still work
      const discordResult = await middleware(discordMessage, discordNext);
      expect(discordResult.success).toBe(true);
    });
  });

  describe("sliding window", () => {
    it("removes old failures from tracking window", async () => {
      const { middleware, getState } = createInspectableCircuitBreakerMiddleware({
        failureThreshold: 5,
        windowMs: 120000, // 2 minutes
      });
      const message = createMessage();

      const next = vi.fn().mockResolvedValue(createFailureResult(message));

      // Send 4 failures
      for (let i = 0; i < 4; i++) {
        await middleware(message, next);
      }

      expect(getState("slack")).toBe("CLOSED");

      // Advance time past the window
      vi.advanceTimersByTime(130000);

      // Send one more failure - should still be closed because old ones expired
      await middleware(message, next);

      expect(getState("slack")).toBe("CLOSED");
    });

    it("opens circuit when failures within window reach threshold", async () => {
      const { middleware, getState } = createInspectableCircuitBreakerMiddleware({
        failureThreshold: 5,
        windowMs: 120000,
      });
      const message = createMessage();

      const next = vi.fn().mockResolvedValue(createFailureResult(message));

      // Send 3 failures
      for (let i = 0; i < 3; i++) {
        await middleware(message, next);
      }

      // Advance time but stay within window
      vi.advanceTimersByTime(60000);

      // Send 2 more failures - total 5 within window
      for (let i = 0; i < 2; i++) {
        await middleware(message, next);
      }

      expect(getState("slack")).toBe("OPEN");
    });
  });

  describe("exception handling", () => {
    it("records failure when next() throws exception", async () => {
      const { middleware, getState } = createInspectableCircuitBreakerMiddleware({
        failureThreshold: 3,
      });
      const message = createMessage();

      const next = vi.fn().mockRejectedValue(new Error("Network error"));

      // Send 3 failures via exceptions
      for (let i = 0; i < 3; i++) {
        await expect(middleware(message, next)).rejects.toThrow("Network error");
      }

      expect(getState("slack")).toBe("OPEN");
    });
  });
});
