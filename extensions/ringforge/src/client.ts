/**
 * Ringforge WebSocket client — Phoenix Channel protocol v2
 *
 * Connects to a Ringforge hub, joins a fleet channel, handles presence,
 * messaging, crypto key exchange, memory, and auto-reconnect with backoff.
 */

// WebSocket — use pre-compiled JS bridge to bypass jiti module resolution.
// The bridge wraps globalThis.WebSocket (Bun native) with Node-style .on() API.
// Falls back to `ws` npm package for pure Node.js environments.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WebSocket: any = (() => {
  try {
    // Pre-compiled bridge (not transpiled by jiti, uses globalThis.WebSocket)
    return require("./ws-bridge.js");
  } catch {
    // Fallback: ws package (Node.js)
    return require("ws");
  }
})();

import {
  protect,
  unprotect,
  decodeSecret,
  type CryptoMode,
  type ProtectedEnvelope,
} from "./crypto.js";

// ── Types ────────────────────────────────────────────────────

export type RingforgeConfig = {
  server: string;
  apiKey: string;
  fleetId: string;
  agentName: string;
  framework?: string;
  capabilities?: string[];
  model?: string;
  /** Crypto mode for outgoing messages (default: sign_encrypt) */
  cryptoMode?: CryptoMode;
};

export type RingforgeMessage = {
  type: string;
  [key: string]: unknown;
};

export type RingforgeAgent = {
  agent_id: string;
  name: string;
  state: string;
  task?: string;
  framework?: string;
  capabilities?: string[];
  model?: string;
};

export type RingforgeEventHandler = {
  onConnected?: (agentId: string) => void;
  onDisconnected?: (reason: string) => void;
  onDirectMessage?: (from: RingforgeAgent, message: RingforgeMessage) => void;
  onPresenceJoined?: (agent: RingforgeAgent) => void;
  onPresenceLeft?: (agentId: string) => void;
  onActivity?: (activity: Record<string, unknown>) => void;
  onRoster?: (agents: RingforgeAgent[]) => void;
  onCryptoKeyReceived?: (kid: string) => void;
  onCryptoKeyRotated?: (kid: string) => void;
};

type PendingReply = {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// ── Client ───────────────────────────────────────────────────

export class RingforgeClient {
  private ws: WebSocketLike | null = null;
  private config: RingforgeConfig;
  private handlers: RingforgeEventHandler;
  private refCounter = 0;
  private joinRef: string | null = null;
  private fleetTopic: string | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private stopped = false;
  private agentId: string | null = null;
  private connectedAt: number | null = null;
  private pendingReplies = new Map<string, PendingReply>();
  private fleetKey: Buffer | null = null;
  private fleetKeyKid = "fleet_key";

  constructor(config: RingforgeConfig, handlers: RingforgeEventHandler = {}) {
    this.config = config;
    this.handlers = handlers;
  }

  // ── Wire helpers ──────────────────────────────────────────

  private makeRef(): string {
    return String(++this.refCounter);
  }

  private send(msg: unknown[]): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private pushChannel(event: string, payload: Record<string, unknown> = {}): string {
    const ref = this.makeRef();
    if (this.fleetTopic) {
      this.send([this.joinRef, ref, this.fleetTopic, event, payload]);
    }
    return ref;
  }

  /**
   * Push a channel event and await the phx_reply.
   * Rejects on error or timeout.
   */
  pushChannelAsync(
    event: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error("Not connected"));
        return;
      }
      const ref = this.pushChannel(event, payload);
      const timer = setTimeout(() => {
        this.pendingReplies.delete(ref);
        reject(new Error(`Timeout waiting for reply to ${event}`));
      }, timeoutMs);
      this.pendingReplies.set(ref, { resolve, reject, timer });
    });
  }

  // ── Connection lifecycle ──────────────────────────────────

  connect(): void {
    this.stopped = false;
    this.fleetKey = null; // Reset crypto on reconnect

    // Keep URL params minimal — full agent info sent in phx_join payload.
    // Complex JSON (arrays, nested objects) can break Phoenix query parsing.
    const agentInfo = JSON.stringify({
      name: this.config.agentName,
    });

    const wsUrl = `${this.config.server}?vsn=2.0.0&api_key=${encodeURIComponent(this.config.apiKey)}&agent=${encodeURIComponent(agentInfo)}`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.connectedAt = Date.now();
      this.reconnectAttempts = 0;

      // Phoenix heartbeat (30s interval)
      this.heartbeatInterval = setInterval(() => {
        this.send([null, this.makeRef(), "phoenix", "heartbeat", {}]);
      }, 30_000);

      this.joinFleet();
    });

    this.ws.on("message", (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        const [_jRef, ref, _topic, event, payload] = msg;
        this.handleMessage(event, payload, ref);
      } catch {
        // Ignore malformed frames
      }
    });

    this.ws.on("close", (_code: number, reason: Buffer) => {
      this.cleanup();
      this.handlers.onDisconnected?.(reason?.toString() || "closed");
      this.scheduleReconnect();
    });

    this.ws.on("error", () => {
      // Swallow — close event fires next
    });
  }

  disconnect(): void {
    this.stopped = true;
    this.cleanup();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const [ref, pending] of this.pendingReplies) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Connection closed"));
      this.pendingReplies.delete(ref);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;

    this.reconnectTimeout = setTimeout(() => this.connect(), delay);
  }

  // ── Fleet join + crypto key ───────────────────────────────

  private joinFleet(): void {
    this.fleetTopic = `fleet:${this.config.fleetId}`;
    this.joinRef = this.makeRef();
    this.send([
      this.joinRef,
      this.makeRef(),
      this.fleetTopic,
      "phx_join",
      {
        payload: {
          name: this.config.agentName,
          framework: this.config.framework || "openclaw",
          capabilities: this.config.capabilities || [],
          state: "online",
        },
      },
    ]);

    // Request crypto key (non-blocking)
    this.fetchCryptoKey();
  }

  private fetchCryptoKey(): void {
    if (!this.fleetTopic) return;

    this.pushChannelAsync("crypto:key", {}, 8_000)
      .then((response) => {
        // Response shape: { type, event, payload: { key, kid, alg, enc, mode } }
        const p = (response as Record<string, unknown>)?.payload as
          | Record<string, unknown>
          | undefined;
        const encodedKey = (p?.key as string) || (response?.key as string);
        const kid = (p?.kid as string) || "fleet_key";

        if (encodedKey) {
          this.fleetKey = decodeSecret(encodedKey);
          this.fleetKeyKid = kid;
          this.handlers.onCryptoKeyReceived?.(kid);
        }
      })
      .catch(() => {
        // Hub doesn't support crypto or key not available — continue plaintext
        this.fleetKey = null;
      });
  }

  // ── Message dispatch ──────────────────────────────────────

  private handleMessage(event: string, payload: Record<string, unknown>, ref?: string): void {
    // Unwrap nested payload (Phoenix convention)
    const p = (payload?.payload as Record<string, unknown>) || payload;

    switch (event) {
      case "phx_reply":
        this.handleReply(payload, ref);
        break;

      case "presence:roster": {
        const agents = ((p as Record<string, unknown>)?.agents || []) as RingforgeAgent[];
        for (const a of agents) {
          if (a.name === this.config.agentName) {
            this.agentId = a.agent_id;
            this.handlers.onConnected?.(a.agent_id);
            break;
          }
        }
        this.handlers.onRoster?.(agents);
        break;
      }

      case "presence:joined":
        this.handlers.onPresenceJoined?.(p as unknown as RingforgeAgent);
        break;

      case "presence:left":
        this.handlers.onPresenceLeft?.((p as Record<string, unknown>)?.agent_id as string);
        break;

      case "direct:message":
        this.handleDirectMessage(p);
        break;

      case "crypto:rotated": {
        const encodedKey = (p as Record<string, unknown>)?.key as string;
        const kid = ((p as Record<string, unknown>)?.kid as string) || "fleet_key";
        if (encodedKey) {
          this.fleetKey = decodeSecret(encodedKey);
          this.fleetKeyKid = kid;
          this.handlers.onCryptoKeyRotated?.(kid);
        }
        break;
      }

      case "activity:broadcast":
        this.handlers.onActivity?.(p);
        break;

      // role:assigned, context:*, notifications — let them pass silently
      default:
        break;
    }
  }

  private handleReply(payload: Record<string, unknown>, ref?: string): void {
    if (ref && this.pendingReplies.has(ref)) {
      const pending = this.pendingReplies.get(ref)!;
      this.pendingReplies.delete(ref);
      clearTimeout(pending.timer);

      const status = payload?.status as string;
      if (status === "ok") {
        pending.resolve((payload?.response as Record<string, unknown>) || {});
      } else {
        pending.reject(
          new Error(`Reply error: ${JSON.stringify(payload?.response || payload).slice(0, 200)}`),
        );
      }
      return;
    }

    // Auto-correct fleet ID mismatch
    const status = payload?.status as string;
    if (status === "error") {
      const resp = payload?.response as Record<string, unknown>;
      if (resp?.reason === "fleet_id_mismatch" && resp?.your_fleet_id) {
        this.config.fleetId = resp.your_fleet_id as string;
        this.joinFleet();
      }
    }
  }

  private handleDirectMessage(p: Record<string, unknown>): void {
    const from = p?.from as RingforgeAgent;
    let message = p?.message as RingforgeMessage;
    const cryptoMeta = p?.crypto as Record<string, unknown>;

    // Attempt decryption if crypto envelope present
    if (cryptoMeta && cryptoMeta.mode !== "none" && this.fleetKey) {
      try {
        const envelope: ProtectedEnvelope = {
          jws: p?.jws as string | undefined,
          jwe: p?.jwe as string | undefined,
          message: message as Record<string, unknown>,
          crypto: cryptoMeta as ProtectedEnvelope["crypto"],
        };
        const result = unprotect(envelope, this.fleetKey);
        if (result.ok) {
          message = result.payload as RingforgeMessage;
        }
      } catch {
        // Decrypt failed — use plaintext fallback
      }
    }

    if (message && from) {
      this.handlers.onDirectMessage?.(from, message);
    }
  }

  // ── Public API ────────────────────────────────────────────

  /** Send a DM (encrypted if fleet key available). */
  sendDM(toAgentId: string, message: RingforgeMessage): void {
    const cryptoMode = this.config.cryptoMode || "sign_encrypt";

    if (cryptoMode !== "none" && this.fleetKey) {
      const envelope = protect(
        message as Record<string, unknown>,
        this.fleetKey,
        cryptoMode,
        this.fleetKeyKid,
      );
      this.pushChannel("direct:send", {
        payload: {
          to: toAgentId,
          message, // Plaintext for server-side storage
          jws: envelope.jws,
          jwe: envelope.jwe,
          crypto: envelope.crypto,
        },
      });
    } else {
      this.pushChannel("direct:send", {
        payload: { to: toAgentId, message },
      });
    }
  }

  /** Send a plain text DM. */
  sendText(toAgentId: string, text: string): void {
    this.sendDM(toAgentId, { type: "text", text });
  }

  /** Broadcast an activity event. */
  broadcastActivity(kind: string, description: string, tags: string[] = []): void {
    this.pushChannel("activity:broadcast", {
      payload: { kind, description, tags },
    });
  }

  /** Update presence state/task/model. */
  updatePresence(update: { state?: string; task?: string; model?: string; load?: number }): void {
    const payload: Record<string, unknown> = {};
    if (update.state) payload.state = update.state;
    if (update.task !== undefined) payload.task = update.task;
    if (update.model) payload.model = update.model;
    if (update.load !== undefined) payload.load = update.load;
    this.pushChannel("presence:update", { payload });
  }

  /** Request a fresh roster push. */
  requestRoster(): void {
    this.pushChannel("presence:roster", {});
  }

  /** Set a fleet memory key. */
  setMemory(key: string, value: unknown): void {
    this.pushChannel("memory:set", { payload: { key, value } });
  }

  /** Get a fleet memory key (async). */
  async getMemoryAsync(key: string): Promise<Record<string, unknown>> {
    return this.pushChannelAsync("memory:get", { payload: { key } });
  }

  // ── Accessors ─────────────────────────────────────────────

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.fleetTopic !== null;
  }

  get currentAgentId(): string | null {
    return this.agentId;
  }

  get uptimeMs(): number {
    return this.connectedAt ? Date.now() - this.connectedAt : 0;
  }

  get hasCrypto(): boolean {
    return this.fleetKey !== null;
  }

  get currentFleetId(): string {
    return this.config.fleetId;
  }
}
