import type { ChannelId, OutboundMiddleware } from "./middleware.js";

export type DeliveryMetrics = {
  success: number;
  failure: number;
  totalLatencyMs: number;
};

export type MetricsSnapshot = {
  byChannel: Record<string, DeliveryMetrics>;
  global: DeliveryMetrics;
};

export function createMetricsMiddleware(): {
  middleware: OutboundMiddleware;
  snapshot: () => MetricsSnapshot;
  reset: () => void;
} {
  const byChannel = new Map<string, DeliveryMetrics>();
  const global: DeliveryMetrics = { success: 0, failure: 0, totalLatencyMs: 0 };

  function getChannel(channel: ChannelId): DeliveryMetrics {
    let m = byChannel.get(channel);
    if (!m) {
      m = { success: 0, failure: 0, totalLatencyMs: 0 };
      byChannel.set(channel, m);
    }
    return m;
  }

  const middleware: OutboundMiddleware = async (msg, next) => {
    const start = Date.now();
    try {
      const result = await next(msg);
      const latency = Date.now() - start;
      const ch = getChannel(msg.channel);
      if (result.ok) {
        ch.success++;
        global.success++;
      } else {
        ch.failure++;
        global.failure++;
      }
      ch.totalLatencyMs += latency;
      global.totalLatencyMs += latency;
      return { ...result, deliveredAt: result.deliveredAt ?? start };
    } catch (err) {
      const latency = Date.now() - start;
      const ch = getChannel(msg.channel);
      ch.failure++;
      ch.totalLatencyMs += latency;
      global.failure++;
      global.totalLatencyMs += latency;
      throw err;
    }
  };

  return {
    middleware,
    snapshot: () => ({
      byChannel: Object.fromEntries(byChannel),
      global: { ...global },
    }),
    reset: () => {
      byChannel.clear();
      global.success = 0;
      global.failure = 0;
      global.totalLatencyMs = 0;
    },
  };
}
