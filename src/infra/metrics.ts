import type { MetricsSnapshot } from "../channels/outbound/metrics.js";
import { getOutboundMetrics } from "../channels/outbound/pipeline.js";

export type InfraMetrics = {
  outbound: MetricsSnapshot | null;
  uptime: number;
  timestamp: number;
};

export function collectMetrics(): InfraMetrics {
  return {
    outbound: getOutboundMetrics(),
    uptime: Math.round(process.uptime() * 1000),
    timestamp: Date.now(),
  };
}
