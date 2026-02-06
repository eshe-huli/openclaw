import type { OutboundMiddleware } from "./middleware.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("outbound");

export function createLogMiddleware(): OutboundMiddleware {
  return async (msg, next) => {
    const start = Date.now();
    log.debug(
      `sending ${msg.channel} → ${msg.to} (text=${msg.text.length}ch media=${Boolean(msg.mediaUrl)})`,
    );
    try {
      const result = await next(msg);
      const elapsed = Date.now() - start;
      if (result.ok) {
        log.debug(
          `delivered ${msg.channel} → ${msg.to} in ${elapsed}ms id=${result.messageId ?? "?"}`,
        );
      } else {
        log.warn(
          `send failed ${msg.channel} → ${msg.to} in ${elapsed}ms: ${result.status ?? "unknown"}`,
        );
      }
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      log.warn(`send error ${msg.channel} → ${msg.to} in ${elapsed}ms: ${formatErrorMessage(err)}`);
      throw err;
    }
  };
}
