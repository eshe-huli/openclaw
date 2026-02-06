import type { MarkdownTableMode } from "../config/types.base.js";
import {
  chunkMarkdownIR,
  markdownToIR,
  type MarkdownIR,
  type MarkdownLinkSpan,
  type MarkdownStyleSpan,
} from "../markdown/ir.js";

/**
 * Feishu Post (rich text) format
 * Reference: https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json#c9e08671
 */

export type FeishuPostElement =
  | { tag: "text"; text: string; style?: string[] }
  | { tag: "a"; text: string; href: string; style?: string[] }
  | { tag: "at"; user_id: string }
  | { tag: "img"; image_key: string }
  | { tag: "media"; file_key: string }
  | { tag: "emotion"; emoji_type: string };

export type FeishuPostLine = FeishuPostElement[];

export type FeishuPostContent = {
  zh_cn?: {
    title?: string;
    content: FeishuPostLine[];
  };
  en_us?: {
    title?: string;
    content: FeishuPostLine[];
  };
};

/**
 * Extract plain text from an incoming Feishu post (rich-text) message.
 * Handles both zh_cn and en_us locales, preferring zh_cn.
 */
export function feishuPostToText(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    return "";
  }
  const post = raw as Record<string, unknown>;
  // Try locale keys in priority order
  const locale =
    (post.zh_cn as { title?: string; content?: unknown[][] } | undefined) ??
    (post.en_us as { title?: string; content?: unknown[][] } | undefined);
  if (!locale || !Array.isArray(locale.content)) {
    return "";
  }
  const lines: string[] = [];
  if (locale.title?.trim()) {
    lines.push(locale.title.trim());
  }
  for (const line of locale.content) {
    if (!Array.isArray(line)) {
      continue;
    }
    const parts: string[] = [];
    for (const el of line) {
      if (!el || typeof el !== "object") {
        continue;
      }
      const element = el as Record<string, unknown>;
      if (element.tag === "text" && typeof element.text === "string") {
        parts.push(element.text);
      } else if (element.tag === "a" && typeof element.text === "string") {
        parts.push(element.text);
      } else if (element.tag === "emotion" && typeof element.emoji_type === "string") {
        parts.push(`[${element.emoji_type}]`);
      }
      // Skip img, media, at tags - not representable as plain text
    }
    lines.push(parts.join(""));
  }
  return lines.join("\n").trim();
}

export type FeishuFormattedChunk = {
  post: FeishuPostContent;
  text: string;
};

type StyleState = {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
};

/**
 * Convert MarkdownIR to Feishu Post format
 */
function renderFeishuPost(ir: MarkdownIR): FeishuPostContent {
  const lines: FeishuPostLine[] = [];
  const text = ir.text;

  if (!text) {
    return { zh_cn: { content: [[{ tag: "text", text: "" }]] } };
  }

  // Build a map of style ranges for quick lookup
  const styleRanges = buildStyleRanges(ir.styles, text.length);
  const linkMap = buildLinkMap(ir.links);

  // Split text into lines
  const textLines = text.split("\n");
  let charIndex = 0;

  for (const line of textLines) {
    const lineElements: FeishuPostElement[] = [];

    if (line.length === 0) {
      // Empty line - add empty text element
      lineElements.push({ tag: "text", text: "" });
    } else {
      // Process each character segment with consistent styling
      let segmentStart = charIndex;
      let currentStyles = getStylesAt(styleRanges, segmentStart);
      let currentLink = getLinkAt(linkMap, segmentStart);

      for (let i = 0; i < line.length; i++) {
        const pos = charIndex + i;
        const newStyles = getStylesAt(styleRanges, pos);
        const newLink = getLinkAt(linkMap, pos);

        // Check if style or link changed
        const stylesChanged = !stylesEqual(currentStyles, newStyles);
        const linkChanged = currentLink !== newLink;

        if (stylesChanged || linkChanged) {
          // Emit previous segment
          const segmentText = text.slice(segmentStart, pos);
          if (segmentText) {
            lineElements.push(createPostElement(segmentText, currentStyles, currentLink));
          }
          segmentStart = pos;
          currentStyles = newStyles;
          currentLink = newLink;
        }
      }

      // Emit final segment of the line
      const finalText = text.slice(segmentStart, charIndex + line.length);
      if (finalText) {
        lineElements.push(createPostElement(finalText, currentStyles, currentLink));
      }
    }

    lines.push(lineElements.length > 0 ? lineElements : [{ tag: "text", text: "" }]);
    charIndex += line.length + 1; // +1 for newline
  }

  return {
    zh_cn: {
      content: lines,
    },
  };
}

function buildStyleRanges(styles: MarkdownStyleSpan[], textLength: number): StyleState[] {
  const ranges: StyleState[] = Array(textLength)
    .fill(null)
    .map(() => ({
      bold: false,
      italic: false,
      strikethrough: false,
      code: false,
    }));

  for (const span of styles) {
    for (let i = span.start; i < span.end && i < textLength; i++) {
      switch (span.style) {
        case "bold":
          ranges[i].bold = true;
          break;
        case "italic":
          ranges[i].italic = true;
          break;
        case "strikethrough":
          ranges[i].strikethrough = true;
          break;
        case "code":
        case "code_block":
          ranges[i].code = true;
          break;
      }
    }
  }

  return ranges;
}

function buildLinkMap(links: MarkdownLinkSpan[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const link of links) {
    for (let i = link.start; i < link.end; i++) {
      map.set(i, link.href);
    }
  }
  return map;
}

function getStylesAt(ranges: StyleState[], pos: number): StyleState {
  return ranges[pos] ?? { bold: false, italic: false, strikethrough: false, code: false };
}

function getLinkAt(linkMap: Map<number, string>, pos: number): string | undefined {
  return linkMap.get(pos);
}

function stylesEqual(a: StyleState, b: StyleState): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strikethrough === b.strikethrough &&
    a.code === b.code
  );
}

function createPostElement(text: string, styles: StyleState, link?: string): FeishuPostElement {
  const styleArray: string[] = [];

  if (styles.bold) {
    styleArray.push("bold");
  }
  if (styles.italic) {
    styleArray.push("italic");
  }
  if (styles.strikethrough) {
    styleArray.push("lineThrough");
  }
  if (styles.code) {
    styleArray.push("code");
  }

  if (link) {
    return {
      tag: "a",
      text,
      href: link,
      ...(styleArray.length > 0 ? { style: styleArray } : {}),
    };
  }

  return {
    tag: "text",
    text,
    ...(styleArray.length > 0 ? { style: styleArray } : {}),
  };
}

/**
 * Convert Markdown to Feishu Post format
 */
export function markdownToFeishuPost(
  markdown: string,
  options: { tableMode?: MarkdownTableMode } = {},
): FeishuPostContent {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    headingStyle: "bold",
    blockquotePrefix: "｜ ",
    tableMode: options.tableMode,
  });
  return renderFeishuPost(ir);
}

/**
 * Convert Markdown to Feishu Post chunks (for long messages)
 */
export function markdownToFeishuChunks(
  markdown: string,
  limit: number,
  options: { tableMode?: MarkdownTableMode } = {},
): FeishuFormattedChunk[] {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    headingStyle: "bold",
    blockquotePrefix: "｜ ",
    tableMode: options.tableMode,
  });
  const chunks = chunkMarkdownIR(ir, limit);
  return chunks.map((chunk) => ({
    post: renderFeishuPost(chunk),
    text: chunk.text,
  }));
}

/**
 * Check if text contains Markdown formatting
 */
export function containsMarkdown(text: string): boolean {
  if (!text) {
    return false;
  }
  // Check for common Markdown patterns
  const markdownPatterns = [
    /\*\*[^*]+\*\*/, // bold
    /\*[^*]+\*/, // italic
    /~~[^~]+~~/, // strikethrough
    /`[^`]+`/, // inline code
    /```[\s\S]*```/, // code block
    /\[.+\]\(.+\)/, // links
    /^#{1,6}\s/m, // headings
    /^[-*]\s/m, // unordered list
    /^\d+\.\s/m, // ordered list
  ];
  return markdownPatterns.some((pattern) => pattern.test(text));
}
