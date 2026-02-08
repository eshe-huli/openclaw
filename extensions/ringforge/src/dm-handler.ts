/**
 * Ringforge DM Handler — Auto-reply pipeline
 *
 * Flow: direct:message → system event → LLM turn → agent_end hook → auto-reply via DM
 *
 * Tracks pending DM conversations and intercepts the LLM's reply in the
 * agent_end hook to send it back to the originating agent automatically.
 */

import type { RingforgeClient, RingforgeAgent, RingforgeMessage } from "./client.js";

// ── Types ────────────────────────────────────────────────────

export type PendingConversation = {
  fromAgentId: string;
  fromName: string;
  message: RingforgeMessage;
  injectedAt: number;
  eventText: string;
  replied: boolean;
};

export type DmHandlerConfig = {
  replyTimeoutMs: number;
  maxPending: number;
  autoReply: boolean;
};

const DEFAULT_CONFIG: DmHandlerConfig = {
  replyTimeoutMs: 120_000, // 2 minutes
  maxPending: 20,
  autoReply: true,
};

/** Tokens that should never be auto-replied */
const SILENT_TOKENS = new Set(["NO_REPLY", "HEARTBEAT_OK", "no_reply", "heartbeat_ok"]);

// ── Handler ──────────────────────────────────────────────────

export class DmHandler {
  private client: RingforgeClient;
  private config: DmHandlerConfig;
  private pending: PendingConversation[] = [];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(client: RingforgeClient, config?: Partial<DmHandlerConfig>) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.pending = [];
  }

  /** Track an incoming DM that was injected as a system event. */
  trackIncoming(from: RingforgeAgent, message: RingforgeMessage, eventText: string): void {
    // Dedup: same agent within 5s → update existing
    const existing = this.pending.find(
      (p) => p.fromAgentId === from.agent_id && !p.replied && Date.now() - p.injectedAt < 5000,
    );
    if (existing) {
      existing.message = message;
      existing.eventText = eventText;
      existing.injectedAt = Date.now();
      return;
    }

    this.pending.push({
      fromAgentId: from.agent_id,
      fromName: from.name || from.agent_id,
      message,
      injectedAt: Date.now(),
      eventText,
      replied: false,
    });

    while (this.pending.length > this.config.maxPending) {
      this.pending.shift();
    }
  }

  /**
   * Called from agent_end hook. Extracts the LLM's reply and sends it back.
   * Returns true if a reply was auto-sent.
   */
  handleAgentEnd(messages: unknown[]): boolean {
    if (!this.config.autoReply || !this.client.isConnected) return false;

    const pendingDm = this.findMostRecentPending();
    if (!pendingDm) return false;

    // If LLM already used ringforge_send, mark as replied and skip
    if (this.turnUsedRingforgeSend(messages)) {
      pendingDm.replied = true;
      return false;
    }

    const reply = this.extractAssistantReply(messages);
    if (!reply) return false;

    // Filter internal/silent tokens
    const trimmed = reply.trim();
    if (SILENT_TOKENS.has(trimmed) || trimmed.length === 0) {
      return false;
    }

    // Don't auto-reply with messages that look like they're meant for the human user
    // (e.g., starts with [[reply_to which is an OpenClaw directive)
    if (trimmed.startsWith("[[reply_to")) return false;

    this.client.sendText(pendingDm.fromAgentId, trimmed);
    pendingDm.replied = true;
    return true;
  }

  hasPending(): boolean {
    return this.pending.some((p) => !p.replied && !this.isExpired(p));
  }

  getMostRecentPending(): PendingConversation | null {
    return this.findMostRecentPending();
  }

  get pendingCount(): number {
    return this.pending.filter((p) => !p.replied && !this.isExpired(p)).length;
  }

  // ── Private ───────────────────────────────────────────────

  private findMostRecentPending(): PendingConversation | null {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (!p.replied && !this.isExpired(p)) return p;
    }
    return null;
  }

  private isExpired(p: PendingConversation): boolean {
    return Date.now() - p.injectedAt > this.config.replyTimeoutMs;
  }

  private extractAssistantReply(messages: unknown[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as Record<string, unknown>;
      if (!msg) continue;

      if (msg.role !== "assistant") continue;

      // String content
      if (typeof msg.content === "string" && msg.content.trim()) {
        return msg.content.trim();
      }

      // Array content (multimodal)
      if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        let hasToolUse = false;

        for (const part of msg.content) {
          const p = part as Record<string, unknown>;
          if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
            textParts.push((p.text as string).trim());
          }
          if (p.type === "tool_use") hasToolUse = true;
        }

        if (textParts.length > 0) return textParts.join("\n");
        if (hasToolUse) continue; // Tool-only message, keep searching
      }

      // Tool calls only (OpenAI format)
      if (msg.tool_calls && !msg.content) continue;

      break;
    }
    return null;
  }

  private turnUsedRingforgeSend(messages: unknown[]): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as Record<string, unknown>;
      if (!msg) continue;

      const role = msg.role as string;
      if (role !== "assistant" && role !== "tool") break;

      if (role === "assistant") {
        // OpenAI format
        const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
        if (
          toolCalls?.some(
            (tc) => (tc.function as Record<string, unknown>)?.name === "ringforge_send",
          )
        ) {
          return true;
        }
        // Anthropic format
        if (Array.isArray(msg.content)) {
          if (msg.content.some((p: any) => p.type === "tool_use" && p.name === "ringforge_send")) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    this.pending = this.pending.filter((p) => {
      if (!p.replied && now - p.injectedAt < this.config.replyTimeoutMs) return true;
      if (p.replied && now - p.injectedAt < 10_000) return true;
      return false;
    });
  }
}
