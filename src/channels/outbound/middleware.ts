/**
 * Cross-channel outbound middleware framework.
 *
 * Middleware functions are composed into a pipeline that processes
 * every outbound message before channel-specific delivery.
 */

export type ChannelId =
  | "telegram"
  | "discord"
  | "slack"
  | "signal"
  | "whatsapp"
  | "line"
  | "feishu"
  | "imessage";

export type OutboundMessage = {
  /** Channel this message targets. */
  channel: ChannelId;
  /** Per-channel account id (when multi-account). */
  accountId?: string;
  /** Recipient address (phone, channel-id, user-id, etc.). */
  to: string;
  /** Text body (may be empty when media-only). */
  text: string;
  /** Optional media URL to attach. */
  mediaUrl?: string;
  /** Opaque bag for channel-specific options. */
  extra?: Record<string, unknown>;
};

export type OutboundResult = {
  /** Whether delivery succeeded. */
  ok: boolean;
  /** Channel-specific message identifier (when available). */
  messageId?: string;
  /** Human-readable status or error description. */
  status?: string;
  /** Timestamp of delivery (epoch ms). */
  deliveredAt?: number;
};

/**
 * A middleware receives the outbound message and a `next` callback.
 * It may:
 *  - modify `msg` and call `next(msg)` to continue the pipeline
 *  - return an `OutboundResult` directly to short-circuit
 *  - throw to signal a hard failure
 */
export type OutboundMiddleware = (
  msg: OutboundMessage,
  next: (msg: OutboundMessage) => Promise<OutboundResult>,
) => Promise<OutboundResult>;

/**
 * Compose an ordered list of middleware into a single function.
 *
 * The final `send` callback is the actual channel delivery function;
 * each middleware wraps the next one, building an onion-style pipeline.
 */
export function composeMiddleware(
  middlewares: OutboundMiddleware[],
  send: (msg: OutboundMessage) => Promise<OutboundResult>,
): (msg: OutboundMessage) => Promise<OutboundResult> {
  // Build the chain from right to left so middlewares[0] runs first.
  let pipeline = send;
  for (let i = middlewares.length - 1; i >= 0; i--) {
    const mw = middlewares[i];
    const next = pipeline;
    pipeline = (msg) => mw(msg, next);
  }
  return pipeline;
}
