import type { OutboundMiddleware } from "./middleware.js";

export function createValidateMiddleware(): OutboundMiddleware {
  return async (msg, next) => {
    const hasText = Boolean(msg.text?.trim());
    const hasMedia = Boolean(msg.mediaUrl?.trim());
    if (!hasText && !hasMedia) {
      return { ok: false, status: "validation: empty message (no text or media)" };
    }
    if (!msg.to?.trim()) {
      return { ok: false, status: "validation: missing recipient" };
    }
    return next(msg);
  };
}
