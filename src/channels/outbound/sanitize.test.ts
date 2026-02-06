import { describe, expect, it } from "vitest";
import type { OutboundMessage, OutboundResult } from "./middleware.js";
import { createSanitizeMiddleware } from "./sanitize.js";

describe("sanitize middleware", () => {
  const mockNext = async (_msg: OutboundMessage): Promise<OutboundResult> => ({
    ok: true,
    messageId: "test-123",
    deliveredAt: Date.now(),
  });

  it("strips zero-width characters", async () => {
    const middleware = createSanitizeMiddleware();
    const message: OutboundMessage = {
      channel: "telegram",
      to: "user123",
      text: "Hello\u200Bworld\u200C\u200D\uFEFF\u2060!",
    };

    let receivedMessage: OutboundMessage | null = null;
    const result = await middleware(message, async (msg) => {
      receivedMessage = msg;
      return mockNext(msg);
    });

    expect(result.ok).toBe(true);
    expect(receivedMessage?.text).toBe("Helloworld!");
  });

  it("collapses excessive newlines", async () => {
    const middleware = createSanitizeMiddleware();
    const message: OutboundMessage = {
      channel: "discord",
      to: "channel123",
      text: "Line 1\n\n\n\n\nLine 2\n\n\nLine 3",
    };

    let receivedMessage: OutboundMessage | null = null;
    await middleware(message, async (msg) => {
      receivedMessage = msg;
      return mockNext(msg);
    });

    expect(receivedMessage?.text).toBe("Line 1\n\nLine 2\n\nLine 3");
  });

  it("truncates to channel max length", async () => {
    const middleware = createSanitizeMiddleware();
    const longText = "a".repeat(5000);
    const message: OutboundMessage = {
      channel: "discord",
      to: "channel123",
      text: longText,
    };

    let receivedMessage: OutboundMessage | null = null;
    await middleware(message, async (msg) => {
      receivedMessage = msg;
      return mockNext(msg);
    });

    expect(receivedMessage?.text.length).toBe(2000); // Discord limit
    expect(receivedMessage?.text).toBe("a".repeat(2000));
  });

  it("strips ANSI escape sequences", async () => {
    const middleware = createSanitizeMiddleware();
    const message: OutboundMessage = {
      channel: "telegram",
      to: "user123",
      text: "\x1B[31mRed text\x1B[0m and \x1B[1mbold\x1B[22m",
    };

    let receivedMessage: OutboundMessage | null = null;
    await middleware(message, async (msg) => {
      receivedMessage = msg;
      return mockNext(msg);
    });

    expect(receivedMessage?.text).toBe("Red text and bold");
  });

  it("normalizes Cyrillic homoglyphs in URLs", async () => {
    const middleware = createSanitizeMiddleware();
    const message: OutboundMessage = {
      channel: "whatsapp",
      to: "+1234567890",
      text: "Check out https://gооglе.com for info", // Cyrillic о, е
    };

    let receivedMessage: OutboundMessage | null = null;
    await middleware(message, async (msg) => {
      receivedMessage = msg;
      return mockNext(msg);
    });

    expect(receivedMessage?.text).toBe("Check out https://google.com for info");
  });

  it("passes through clean text unchanged", async () => {
    const middleware = createSanitizeMiddleware();
    const cleanText = "This is a clean message with no issues!";
    const message: OutboundMessage = {
      channel: "telegram",
      to: "user123",
      text: cleanText,
    };

    let receivedMessage: OutboundMessage | null = null;
    await middleware(message, async (msg) => {
      receivedMessage = msg;
      return mockNext(msg);
    });

    expect(receivedMessage?.text).toBe(cleanText);
    // Should not create a new object if no modifications
    expect(receivedMessage).toBe(message);
  });

  it("respects config overrides for maxLength", async () => {
    const middleware = createSanitizeMiddleware({
      maxLength: { discord: 100 },
    });
    const longText = "b".repeat(200);
    const message: OutboundMessage = {
      channel: "discord",
      to: "channel123",
      text: longText,
    };

    let receivedMessage: OutboundMessage | null = null;
    await middleware(message, async (msg) => {
      receivedMessage = msg;
      return mockNext(msg);
    });

    expect(receivedMessage?.text.length).toBe(100);
    expect(receivedMessage?.text).toBe("b".repeat(100));
  });

  it("respects stripZeroWidth config option", async () => {
    const middleware = createSanitizeMiddleware({ stripZeroWidth: false });
    const message: OutboundMessage = {
      channel: "telegram",
      to: "user123",
      text: "Hello\u200Bworld",
    };

    let receivedMessage: OutboundMessage | null = null;
    await middleware(message, async (msg) => {
      receivedMessage = msg;
      return mockNext(msg);
    });

    // Zero-width char should remain when stripZeroWidth is false
    expect(receivedMessage?.text).toBe("Hello\u200Bworld");
  });

  it("trims leading and trailing whitespace", async () => {
    const middleware = createSanitizeMiddleware();
    const message: OutboundMessage = {
      channel: "slack",
      to: "C123456",
      text: "   \n  Message with spaces  \n  ",
    };

    let receivedMessage: OutboundMessage | null = null;
    await middleware(message, async (msg) => {
      receivedMessage = msg;
      return mockNext(msg);
    });

    expect(receivedMessage?.text).toBe("Message with spaces");
  });

  it("handles empty text by passing through", async () => {
    const middleware = createSanitizeMiddleware();
    const message: OutboundMessage = {
      channel: "telegram",
      to: "user123",
      text: "",
      mediaUrl: "https://example.com/image.png",
    };

    let receivedMessage: OutboundMessage | null = null;
    await middleware(message, async (msg) => {
      receivedMessage = msg;
      return mockNext(msg);
    });

    expect(receivedMessage).toBe(message);
  });

  it("handles multiple URLs with homoglyphs", async () => {
    const middleware = createSanitizeMiddleware();
    const message: OutboundMessage = {
      channel: "telegram",
      to: "user123",
      text: "Visit https://ехаmplе.com and http://tеst.org", // Mixed Cyrillic chars
    };

    let receivedMessage: OutboundMessage | null = null;
    await middleware(message, async (msg) => {
      receivedMessage = msg;
      return mockNext(msg);
    });

    expect(receivedMessage?.text).toBe("Visit https://example.com and http://test.org");
  });

  it("applies all sanitization rules together", async () => {
    const middleware = createSanitizeMiddleware();
    const message: OutboundMessage = {
      channel: "discord",
      to: "channel123",
      text: "  \x1B[31mAlert!\x1B[0m\n\n\n\nVisit https://gооglе.com\u200B  ",
    };

    let receivedMessage: OutboundMessage | null = null;
    await middleware(message, async (msg) => {
      receivedMessage = msg;
      return mockNext(msg);
    });

    expect(receivedMessage?.text).toBe("Alert!\n\nVisit https://google.com");
  });
});
