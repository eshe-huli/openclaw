import type { ChannelId, OutboundMessage, OutboundResult } from "./middleware.js";
import { createOutboundPipeline } from "./pipeline.js";

/**
 * Bridge between the raw `deliverOutboundPayloads` function and the outbound pipeline.
 *
 * Wraps a channel-specific delivery function with the full middleware stack
 * (logging, dedup, metrics, circuit-breaker, rate-limit, optional retry).
 */
export function createDeliveryAdapter(
  channel: ChannelId,
  deliver: (msg: OutboundMessage) => Promise<OutboundResult>,
): (msg: OutboundMessage) => Promise<OutboundResult> {
  return createOutboundPipeline(channel, deliver);
}
