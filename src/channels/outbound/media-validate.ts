import type { ChannelId, OutboundMiddleware } from "./middleware.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("outbound-media");

/** Per-channel max media sizes in bytes. */
const DEFAULT_MAX_MEDIA_BYTES: Partial<Record<ChannelId, number>> = {
  telegram: 50 * 1024 * 1024, // 50 MB
  discord: 25 * 1024 * 1024, // 25 MB (Nitro: 100 MB)
  slack: 1024 * 1024 * 1024, // 1 GB
  signal: 100 * 1024 * 1024, // 100 MB
  whatsapp: 16 * 1024 * 1024, // 16 MB
  line: 200 * 1024 * 1024, // 200 MB
  feishu: 30 * 1024 * 1024, // 30 MB
  imessage: 100 * 1024 * 1024, // 100 MB
};

export type MediaValidateConfig = {
  /** Override per-channel max bytes. */
  maxBytes?: Partial<Record<ChannelId, number>>;
  /** Whether to perform a HEAD request to check content-type/size. Default: false. */
  headCheck?: boolean;
  /** Timeout for HEAD requests in ms. Default: 5000. */
  headTimeoutMs?: number;
};

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:"
    );
  } catch {
    return false;
  }
}

export function createMediaValidateMiddleware(
  config: MediaValidateConfig = {},
): OutboundMiddleware {
  const headCheck = config.headCheck ?? false;
  const headTimeoutMs = config.headTimeoutMs ?? 5000;

  return async (msg, next) => {
    if (!msg.mediaUrl?.trim()) {
      return next(msg);
    }

    // URL format check
    if (!isValidUrl(msg.mediaUrl)) {
      log.warn(`invalid media URL for ${msg.channel}: ${msg.mediaUrl.slice(0, 100)}`);
      // Strip invalid media and try text-only
      if (msg.text?.trim()) {
        log.debug(`stripping invalid media, falling back to text-only`);
        return next({ ...msg, mediaUrl: undefined });
      }
      return { ok: false, status: "media-validate: invalid URL format" };
    }

    // Optional HEAD request for remote URLs
    if (headCheck && (msg.mediaUrl.startsWith("http:") || msg.mediaUrl.startsWith("https:"))) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), headTimeoutMs);
        const resp = await fetch(msg.mediaUrl, {
          method: "HEAD",
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timer);

        if (!resp.ok) {
          log.warn(`media HEAD check failed for ${msg.channel}: HTTP ${resp.status}`);
          if (msg.text?.trim()) {
            return next({ ...msg, mediaUrl: undefined });
          }
          return { ok: false, status: `media-validate: HEAD returned ${resp.status}` };
        }

        // Check size against channel limits
        const contentLength = resp.headers.get("content-length");
        if (contentLength) {
          const size = parseInt(contentLength, 10);
          const maxBytes = config.maxBytes?.[msg.channel] ?? DEFAULT_MAX_MEDIA_BYTES[msg.channel];
          if (maxBytes && size > maxBytes) {
            log.warn(`media too large for ${msg.channel}: ${size} > ${maxBytes} bytes`);
            if (msg.text?.trim()) {
              return next({ ...msg, mediaUrl: undefined });
            }
            return {
              ok: false,
              status: `media-validate: file too large (${size} > ${maxBytes} bytes)`,
            };
          }
        }
      } catch (err) {
        log.debug(
          `media HEAD check error (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
        );
        // Non-blocking: proceed anyway, let the actual send handle the error
      }
    }

    return next(msg);
  };
}
