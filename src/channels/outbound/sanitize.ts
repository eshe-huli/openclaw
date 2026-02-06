/**
 * Content sanitization middleware for outbound messages.
 *
 * Strips potentially dangerous or tracking content before delivery:
 * - Zero-width characters used for fingerprinting
 * - Excessive whitespace
 * - ANSI escape sequences
 * - Normalizes Unicode homoglyphs in URLs
 * - Enforces per-channel length limits
 *
 * @example
 * ```typescript
 * import { composeMiddleware, createSanitizeMiddleware } from "./channels/outbound/index.js";
 *
 * // Basic usage
 * const sanitize = createSanitizeMiddleware();
 * const pipeline = composeMiddleware([sanitize], actualSendFunction);
 *
 * // With custom config
 * const sanitize = createSanitizeMiddleware({
 *   maxLength: { discord: 1000 }, // Override Discord limit
 *   stripZeroWidth: false,          // Keep zero-width chars
 * });
 * ```
 */

import type {
  ChannelId,
  OutboundMessage,
  OutboundMiddleware,
  OutboundResult,
} from "./middleware.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const logger = createSubsystemLogger("sanitize");

// Zero-width characters commonly used for tracking/fingerprinting
const ZERO_WIDTH_CHARS = /[\u200B\u200C\u200D\uFEFF\u2060]/g;

// ANSI escape sequences
const ANSI_ESCAPE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// Per-channel maximum text length
const CHANNEL_MAX_LENGTH: Record<ChannelId, number> = {
  whatsapp: 65536,
  telegram: 4096,
  discord: 2000,
  slack: 40000,
  signal: 4096,
  line: 4096,
  feishu: 4096,
  imessage: 4096,
};

// Cyrillic homoglyphs commonly used in phishing URLs
const CYRILLIC_HOMOGLYPHS: Record<string, string> = {
  а: "a", // U+0430 → a
  е: "e", // U+0435 → e
  о: "o", // U+043E → o
  р: "p", // U+0440 → p
  с: "c", // U+0441 → c
  у: "y", // U+0443 → y
  х: "x", // U+0445 → x
  А: "A", // U+0410 → A
  В: "B", // U+0412 → B
  Е: "E", // U+0415 → E
  К: "K", // U+041A → K
  М: "M", // U+041C → M
  Н: "H", // U+041D → H
  О: "O", // U+041E → O
  Р: "P", // U+0420 → P
  С: "C", // U+0421 → C
  Т: "T", // U+0422 → T
  Х: "X", // U+0425 → X
};

const CYRILLIC_HOMOGLYPH_REGEX = new RegExp(`[${Object.keys(CYRILLIC_HOMOGLYPHS).join("")}]`, "g");

// Simple URL pattern to target normalization
const URL_PATTERN = /(https?:\/\/[^\s]+)/gi;

export interface SanitizeConfig {
  /** Override per-channel max length limits */
  maxLength?: Partial<Record<ChannelId, number>>;
  /** Whether to strip zero-width characters (default: true) */
  stripZeroWidth?: boolean;
}

function normalizeHomoglyphsInUrl(url: string): string {
  return url.replace(CYRILLIC_HOMOGLYPH_REGEX, (char) => CYRILLIC_HOMOGLYPHS[char] || char);
}

function sanitizeText(
  text: string,
  channel: ChannelId,
  config: SanitizeConfig,
): { text: string; modified: boolean } {
  let result = text;
  let modified = false;

  // Strip zero-width characters
  if (config.stripZeroWidth !== false) {
    const stripped = result.replace(ZERO_WIDTH_CHARS, "");
    if (stripped !== result) {
      logger.debug("Stripped zero-width characters", { channel });
      result = stripped;
      modified = true;
    }
  }

  // Strip ANSI escape sequences
  const noAnsi = result.replace(ANSI_ESCAPE, "");
  if (noAnsi !== result) {
    logger.debug("Stripped ANSI escape sequences", { channel });
    result = noAnsi;
    modified = true;
  }

  // Normalize Cyrillic homoglyphs in URLs
  const normalized = result.replace(URL_PATTERN, (url) => {
    const fixed = normalizeHomoglyphsInUrl(url);
    if (fixed !== url) {
      logger.debug("Normalized homoglyphs in URL", { channel, url });
      modified = true;
    }
    return fixed;
  });
  result = normalized;

  // Collapse excessive newlines (more than 2 consecutive → 2)
  const collapsedNewlines = result.replace(/\n{3,}/g, "\n\n");
  if (collapsedNewlines !== result) {
    logger.debug("Collapsed excessive newlines", { channel });
    result = collapsedNewlines;
    modified = true;
  }

  // Trim leading/trailing whitespace
  const trimmed = result.trim();
  if (trimmed !== result) {
    logger.debug("Trimmed leading/trailing whitespace", { channel });
    result = trimmed;
    modified = true;
  }

  // Enforce max length for channel
  const maxLength = config.maxLength?.[channel] ?? CHANNEL_MAX_LENGTH[channel];
  if (result.length > maxLength) {
    logger.debug("Truncated text to channel max length", {
      channel,
      original: result.length,
      max: maxLength,
    });
    result = result.slice(0, maxLength);
    modified = true;
  }

  return { text: result, modified };
}

/**
 * Create a sanitization middleware with optional config overrides.
 */
export function createSanitizeMiddleware(config: SanitizeConfig = {}): OutboundMiddleware {
  return async (
    msg: OutboundMessage,
    next: (msg: OutboundMessage) => Promise<OutboundResult>,
  ): Promise<OutboundResult> => {
    // Skip if no text to sanitize
    if (!msg.text || msg.text.length === 0) {
      return next(msg);
    }

    const { text, modified } = sanitizeText(msg.text, msg.channel, config);

    // Create new message object with sanitized text if modified
    const sanitizedMsg = modified ? { ...msg, text } : msg;

    return next(sanitizedMsg);
  };
}
