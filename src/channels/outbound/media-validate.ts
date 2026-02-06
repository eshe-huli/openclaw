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

function isPrivateIp(hostname: string): boolean {
  // Block localhost and private IP ranges
  if (hostname === "localhost" || hostname === "0.0.0.0") {
    return true;
  }

  // Parse IP address (basic IPv4 check)
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipMatch) {
    return false;
  } // Not an IP, allow (will be resolved by DNS)

  const octets = ipMatch.slice(1, 5).map(Number);

  // 127.0.0.0/8 (loopback)
  if (octets[0] === 127) {
    return true;
  }

  // 10.0.0.0/8 (private)
  if (octets[0] === 10) {
    return true;
  }

  // 172.16.0.0/12 (private)
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
    return true;
  }

  // 192.168.0.0/16 (private)
  if (octets[0] === 192 && octets[1] === 168) {
    return true;
  }

  // 169.254.0.0/16 (link-local)
  if (octets[0] === 169 && octets[1] === 254) {
    return true;
  }

  return false;
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only allow http and https protocols
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    // Block private IP addresses
    if (isPrivateIp(parsed.hostname)) {
      return false;
    }
    return true;
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
          redirect: "manual",
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
