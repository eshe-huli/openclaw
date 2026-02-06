import type { GatewayRequestHandlers } from "./types.js";
import { getOutboundQueue } from "../../channels/outbound/pipeline.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

const log = createSubsystemLogger("dead-letters");

export const deadLetterHandlers: GatewayRequestHandlers = {
  "outbound.deadLetters": async ({ respond, params }) => {
    const rawLimit = typeof params.limit === "number" ? params.limit : 50;
    const limit = Math.min(Math.max(1, rawLimit), 500);
    const queue = getOutboundQueue();
    if (!queue) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "outbound queue not initialized"),
      );
      return;
    }
    const deadLetters = await queue.deadLetters(limit);

    const formatted = deadLetters.map((entry) => ({
      id: entry.id,
      channel: entry.message.channel,
      to: entry.message.to,
      text: entry.message.text,
      mediaUrl: entry.message.mediaUrl,
      attempts: entry.attempts,
      lastError: entry.lastError,
      createdAt: new Date(entry.createdAt).toISOString(),
    }));

    log.debug(`listing ${formatted.length} dead letters`);
    respond(true, { deadLetters: formatted, count: formatted.length });
  },

  "outbound.deadLetters.retry": async ({ respond, params }) => {
    const id = params.id;
    if (typeof id !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing or invalid id"));
      return;
    }

    const queue = getOutboundQueue();
    if (!queue) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "outbound queue not initialized"),
      );
      return;
    }
    const success = await queue.retryDeadLetter(id);

    if (success) {
      log.info(`retried dead letter ${id}`);
      respond(true, { id, retried: true });
    } else {
      log.warn(`failed to retry dead letter ${id} (not found or not dead)`);
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "dead letter not found"));
    }
  },

  "outbound.deadLetters.purge": async ({ respond }) => {
    const queue = getOutboundQueue();
    if (!queue) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "outbound queue not initialized"),
      );
      return;
    }
    const deleted = await queue.purgeDeadLetters();

    log.info(`purged ${deleted} dead letters`);
    respond(true, { deleted });
  },

  "outbound.queue.stats": async ({ respond }) => {
    const queue = getOutboundQueue();
    if (!queue) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "outbound queue not initialized"),
      );
      return;
    }
    const stats = await queue.stats();

    log.debug(`queue stats: ${JSON.stringify(stats)}`);
    respond(true, stats);
  },
};
