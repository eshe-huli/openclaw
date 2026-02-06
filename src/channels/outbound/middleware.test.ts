import { describe, it, expect, vi } from "vitest";
import {
  composeMiddleware,
  type OutboundMessage,
  type OutboundMiddleware,
  type OutboundResult,
} from "./middleware.js";

const makeMsg = (overrides?: Partial<OutboundMessage>): OutboundMessage => ({
  channel: "telegram",
  to: "+1234567890",
  text: "hello",
  ...overrides,
});

const okResult = (id = "msg-1"): OutboundResult => ({
  ok: true,
  messageId: id,
  deliveredAt: Date.now(),
});

describe("composeMiddleware", () => {
  it("calls send directly when no middleware", async () => {
    const send = vi.fn().mockResolvedValue(okResult());
    const pipeline = composeMiddleware([], send);
    const msg = makeMsg();
    const result = await pipeline(msg);
    expect(send).toHaveBeenCalledWith(msg);
    expect(result.ok).toBe(true);
  });

  it("runs middleware in order", async () => {
    const order: string[] = [];
    const mw1: OutboundMiddleware = async (msg, next) => {
      order.push("mw1-before");
      const result = await next(msg);
      order.push("mw1-after");
      return result;
    };
    const mw2: OutboundMiddleware = async (msg, next) => {
      order.push("mw2-before");
      const result = await next(msg);
      order.push("mw2-after");
      return result;
    };
    const send = vi.fn().mockImplementation(async () => {
      order.push("send");
      return okResult();
    });
    const pipeline = composeMiddleware([mw1, mw2], send);
    await pipeline(makeMsg());
    expect(order).toEqual(["mw1-before", "mw2-before", "send", "mw2-after", "mw1-after"]);
  });

  it("allows middleware to short-circuit", async () => {
    const blocker: OutboundMiddleware = async () => ({
      ok: false,
      status: "blocked",
    });
    const send = vi.fn().mockResolvedValue(okResult());
    const pipeline = composeMiddleware([blocker], send);
    const result = await pipeline(makeMsg());
    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(send).not.toHaveBeenCalled();
  });

  it("allows middleware to modify message", async () => {
    const modifier: OutboundMiddleware = async (msg, next) => {
      return next({ ...msg, text: msg.text.toUpperCase() });
    };
    const send = vi.fn().mockResolvedValue(okResult());
    const pipeline = composeMiddleware([modifier], send);
    await pipeline(makeMsg({ text: "hello" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "HELLO" }));
  });

  it("propagates errors from send", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network"));
    const pipeline = composeMiddleware([], send);
    await expect(pipeline(makeMsg())).rejects.toThrow("network");
  });

  it("propagates errors from middleware", async () => {
    const broken: OutboundMiddleware = async () => {
      throw new Error("middleware broke");
    };
    const send = vi.fn();
    const pipeline = composeMiddleware([broken], send);
    await expect(pipeline(makeMsg())).rejects.toThrow("middleware broke");
  });
});
