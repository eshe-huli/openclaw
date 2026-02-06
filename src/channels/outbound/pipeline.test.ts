import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDedupMiddleware } from "./dedup.js";
import { createLogMiddleware } from "./log.js";
import { createMetricsMiddleware } from "./metrics.js";
import { composeMiddleware, type OutboundMessage, type OutboundResult } from "./middleware.js";
import { createValidateMiddleware } from "./validate.js";

const makeMsg = (overrides?: Partial<OutboundMessage>): OutboundMessage => ({
  channel: "telegram",
  to: "+1234567890",
  text: "hello world",
  ...overrides,
});

const okResult = (): OutboundResult => ({
  ok: true,
  messageId: "test-123",
  deliveredAt: Date.now(),
});

describe("outbound pipeline integration", () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn().mockResolvedValue(okResult());
  });

  it("full pipeline delivers a valid message", async () => {
    const { middleware: metrics, snapshot } = createMetricsMiddleware();
    const pipeline = composeMiddleware(
      [createLogMiddleware(), createValidateMiddleware(), metrics],
      send,
    );
    const result = await pipeline(makeMsg());
    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const snap = snapshot();
    expect(snap.global.success).toBe(1);
    expect(snap.global.failure).toBe(0);
  });

  it("validation blocks empty message before reaching send", async () => {
    const pipeline = composeMiddleware([createValidateMiddleware()], send);
    const result = await pipeline(makeMsg({ text: "", mediaUrl: undefined }));
    expect(result.ok).toBe(false);
    expect(result.status).toContain("validation");
    expect(send).not.toHaveBeenCalled();
  });

  it("validation blocks missing recipient", async () => {
    const pipeline = composeMiddleware([createValidateMiddleware()], send);
    const result = await pipeline(makeMsg({ to: "" }));
    expect(result.ok).toBe(false);
    expect(result.status).toContain("recipient");
    expect(send).not.toHaveBeenCalled();
  });

  it("dedup suppresses duplicate messages", async () => {
    const dedup = createDedupMiddleware({ ttlMs: 5000 });
    const pipeline = composeMiddleware([dedup], send);
    const msg = makeMsg();
    const r1 = await pipeline(msg);
    const r2 = await pipeline(msg);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.status).toContain("dedup");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("dedup allows different messages", async () => {
    const dedup = createDedupMiddleware({ ttlMs: 5000 });
    const pipeline = composeMiddleware([dedup], send);
    await pipeline(makeMsg({ text: "hello" }));
    await pipeline(makeMsg({ text: "world" }));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("metrics track success and failure", async () => {
    const { middleware: metrics, snapshot, reset } = createMetricsMiddleware();
    const failSend = vi
      .fn()
      .mockResolvedValueOnce(okResult())
      .mockResolvedValueOnce({ ok: false, status: "error" });
    const pipeline = composeMiddleware([metrics], failSend);

    await pipeline(makeMsg());
    await pipeline(makeMsg({ text: "fail" }));

    const snap = snapshot();
    expect(snap.global.success).toBe(1);
    expect(snap.global.failure).toBe(1);
    expect(snap.byChannel.telegram).toBeDefined();

    reset();
    const afterReset = snapshot();
    expect(afterReset.global.success).toBe(0);
  });

  it("metrics track latency on exceptions", async () => {
    const { middleware: metrics, snapshot } = createMetricsMiddleware();
    const errorSend = vi.fn().mockRejectedValue(new Error("boom"));
    const pipeline = composeMiddleware([metrics], errorSend);

    await expect(pipeline(makeMsg())).rejects.toThrow("boom");
    const snap = snapshot();
    expect(snap.global.failure).toBe(1);
    expect(snap.global.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("allows media-only messages", async () => {
    const pipeline = composeMiddleware([createValidateMiddleware()], send);
    const result = await pipeline(makeMsg({ text: "", mediaUrl: "https://example.com/img.png" }));
    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("composed pipeline handles channel-specific messages", async () => {
    const { middleware: metrics, snapshot } = createMetricsMiddleware();
    const pipeline = composeMiddleware([createValidateMiddleware(), metrics], send);

    await pipeline(makeMsg({ channel: "discord", to: "chan-123" }));
    await pipeline(makeMsg({ channel: "slack", to: "#general" }));

    const snap = snapshot();
    expect(snap.byChannel.discord?.success).toBe(1);
    expect(snap.byChannel.slack?.success).toBe(1);
    expect(snap.global.success).toBe(2);
  });
});
