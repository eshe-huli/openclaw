/**
 * Ringforge WebSocket client — Phoenix Channel protocol v2
 *
 * Connects to a Ringforge hub, joins a fleet channel, handles presence,
 * messaging, memory, and auto-reconnect.
 */

import WebSocket from "ws";

export type RingforgeConfig = {
  server: string;
  apiKey: string;
  fleetId: string;
  agentName: string;
  framework?: string;
  capabilities?: string[];
  model?: string;
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
};

export type RingforgeEventHandler = {
  onConnected?: (agentId: string) => void;
  onDisconnected?: (reason: string) => void;
  onDirectMessage?: (from: RingforgeAgent, message: RingforgeMessage) => void;
  onPresenceJoined?: (agent: RingforgeAgent) => void;
  onPresenceLeft?: (agentId: string) => void;
  onActivity?: (activity: Record<string, unknown>) => void;
  onRoster?: (agents: RingforgeAgent[]) => void;
};

type PendingReply = {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RingforgeClient {
  private ws: WebSocket | null = null;
  private config: RingforgeConfig;
  private handlers: RingforgeEventHandler;
  private refCounter = 0;
  private joinRef: string | null = null;
  private fleetTopic: string | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private agentId: string | null = null;
  private connectedAt: number | null = null;
  private pendingReplies = new Map<string, PendingReply>();

  constructor(config: RingforgeConfig, handlers: RingforgeEventHandler = {}) {
    this.config = config;
    this.handlers = handlers;
  }

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
   * Push a channel event and wait for the phx_reply.
   * Returns the reply response payload. Rejects on error or timeout.
   */
  private pushChannelAsync(
    event: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const ref = this.pushChannel(event, payload);
      const timer = setTimeout(() => {
        this.pendingReplies.delete(ref);
        reject(new Error(`Timeout waiting for reply to ${event}`));
      }, timeoutMs);
      this.pendingReplies.set(ref, { resolve, reject, timer });
    });
  }

  connect(): void {
    this.stopped = false;
    const agentInfo = JSON.stringify({
      name: this.config.agentName,
      framework: this.config.framework || "openclaw",
      capabilities: this.config.capabilities || [],
      model: this.config.model || undefined,
    });

    const wsUrl = `${this.config.server}?vsn=2.0.0&api_key=${encodeURIComponent(this.config.apiKey)}&agent=${encodeURIComponent(agentInfo)}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      this.connectedAt = Date.now();

      // Phoenix heartbeat
      this.heartbeatInterval = setInterval(() => {
        this.send([null, this.makeRef(), "phoenix", "heartbeat", {}]);
      }, 30000);

      // Join fleet channel
      this.joinFleet();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        const [_jRef, ref, topic, event, payload] = msg;
        this.handleMessage(topic, event, payload, ref);
      } catch {
        // ignore malformed messages
      }
    });

    this.ws.on("close", (_code: number, reason: Buffer) => {
      this.cleanup();
      const reasonStr = reason?.toString() || "unknown";
      this.handlers.onDisconnected?.(reasonStr);
      this.scheduleReconnect();
    });

    this.ws.on("error", () => {
      // error handler to prevent unhandled exception — close will fire next
    });
  }

  disconnect(): void {
    this.stopped = true;
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    // Reject all pending replies
    for (const [ref, pending] of this.pendingReplies) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Connection closed"));
      this.pendingReplies.delete(ref);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, 3000);
  }

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
  }

  private handleMessage(
    topic: string,
    event: string,
    payload: Record<string, unknown>,
    ref?: string,
  ): void {
    const p = (payload?.payload as Record<string, unknown>) || payload;

    switch (event) {
      case "phx_reply": {
        // Resolve pending async replies
        if (ref && this.pendingReplies.has(ref)) {
          const pending = this.pendingReplies.get(ref)!;
          this.pendingReplies.delete(ref);
          clearTimeout(pending.timer);
          const status = (payload as Record<string, unknown>)?.status;
          if (status === "ok") {
            const response = (payload as Record<string, unknown>)?.response;
            pending.resolve((response as Record<string, unknown>) || {});
          } else {
            const response = (payload as Record<string, unknown>)?.response;
            pending.reject(
              new Error(`Reply error: ${JSON.stringify(response || payload).slice(0, 200)}`),
            );
          }
          return;
        }

        const status = (payload as Record<string, unknown>)?.status;
        if (status === "error") {
          const resp = (payload as Record<string, unknown>)?.response as Record<string, unknown>;
          if (resp?.reason === "fleet_id_mismatch" && resp?.your_fleet_id) {
            this.config.fleetId = resp.your_fleet_id as string;
            this.joinFleet();
          }
        }
        break;
      }

      case "presence:joined": {
        const agent = p as unknown as RingforgeAgent;
        this.handlers.onPresenceJoined?.(agent);
        break;
      }

      case "presence:left": {
        const agentId = (p as Record<string, unknown>)?.agent_id as string;
        this.handlers.onPresenceLeft?.(agentId);
        break;
      }

      case "presence:roster": {
        const agents = ((p as Record<string, unknown>)?.agents || []) as RingforgeAgent[];
        // Extract own agent_id from roster
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

      case "direct:message": {
        const from = (p as Record<string, unknown>)?.from as RingforgeAgent;
        const message = (p as Record<string, unknown>)?.message as RingforgeMessage;
        if (message && from) {
          this.handlers.onDirectMessage?.(from, message);
        }
        break;
      }

      case "activity:broadcast": {
        this.handlers.onActivity?.(p);
        break;
      }

      // presence_diff — ignore (roster handles it)
      default:
        break;
    }
  }

  // ── Public API ────────────────────────────────────────────

  sendDM(toAgentId: string, message: RingforgeMessage): void {
    this.pushChannel("direct:send", {
      payload: { to: toAgentId, message },
    });
  }

  sendText(toAgentId: string, text: string): void {
    this.sendDM(toAgentId, { type: "text", text });
  }

  broadcastActivity(kind: string, description: string, tags: string[] = []): void {
    this.pushChannel("activity:broadcast", {
      payload: { kind, description, tags },
    });
  }

  updatePresence(state: string, task?: string): void {
    this.pushChannel("presence:update", {
      payload: { state, task: task || null },
    });
  }

  requestRoster(): void {
    this.pushChannel("presence:roster", {});
  }

  setMemory(key: string, value: unknown): void {
    this.pushChannel("memory:set", { payload: { key, value } });
  }

  /**
   * Get a memory value. Returns the reply payload with the value.
   */
  async getMemoryAsync(key: string): Promise<Record<string, unknown>> {
    return this.pushChannelAsync("memory:get", { payload: { key } });
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.fleetTopic !== null;
  }

  get currentAgentId(): string | null {
    return this.agentId;
  }

  get uptimeMs(): number {
    return this.connectedAt ? Date.now() - this.connectedAt : 0;
  }
}
