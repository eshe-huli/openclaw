import type { GatewayRequestHandlers } from "./types.js";
import { collectMetrics } from "../../infra/metrics.js";

export const metricsHandlers: GatewayRequestHandlers = {
  "outbound.metrics": async ({ respond }) => {
    const metrics = collectMetrics();
    respond(true, metrics);
  },
  "outbound.metrics.reset": async ({ respond }) => {
    const { resetOutboundMetrics } = await import("../../channels/outbound/pipeline.js");
    resetOutboundMetrics();
    respond(true, { reset: true });
  },
};
