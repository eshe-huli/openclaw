// @bun
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = typeof require !== "undefined" ? require : function(m) { throw new Error("require not available: " + m); };

// src/ws-bridge.js
var require_ws_bridge = __commonJS((exports, module) => {
  class BridgeWebSocket {
    constructor(url) {
      this._ws = new globalThis.WebSocket(url);
    }
    get readyState() {
      return this._ws.readyState;
    }
    send(data) {
      this._ws.send(data);
    }
    close() {
      this._ws.close();
    }
    on(event, fn) {
      if (event === "open")
        this._ws.addEventListener("open", () => fn());
      else if (event === "message")
        this._ws.addEventListener("message", (ev) => fn(ev.data));
      else if (event === "close")
        this._ws.addEventListener("close", (ev) => fn(ev.code, ev.reason));
      else if (event === "error")
        this._ws.addEventListener("error", () => fn());
    }
  }
  BridgeWebSocket.OPEN = 1;
  BridgeWebSocket.CLOSED = 3;
  module.exports = BridgeWebSocket;
  module.exports.default = BridgeWebSocket;
});

// src/crypto.ts
import { createHmac, randomBytes, createCipheriv, createDecipheriv } from "crypto";
function base64UrlEncode(data) {
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  return buf.toString("base64url");
}
function base64UrlDecode(str) {
  return Buffer.from(str, "base64url");
}
function jwsSign(payload, secret, kid = "fleet_key") {
  const header = { alg: "HS256", kid, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    payload,
    iat: now,
    nbf: now - 5,
    exp: now + 300
  };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const claimsB64 = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${headerB64}.${claimsB64}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest();
  const sigB64 = base64UrlEncode(signature);
  return `${headerB64}.${claimsB64}.${sigB64}`;
}
function jwsVerify(compact, secret, opts = {}) {
  const checkExp = opts.checkExp !== false;
  const parts = compact.split(".");
  if (parts.length !== 3)
    return { ok: false, error: "invalid_format" };
  const [headerB64, claimsB64, sigB64] = parts;
  const signingInput = `${headerB64}.${claimsB64}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest();
  const actual = base64UrlDecode(sigB64);
  if (!expected.equals(actual))
    return { ok: false, error: "invalid_signature" };
  try {
    const header = JSON.parse(base64UrlDecode(headerB64).toString());
    if (header.alg !== "HS256")
      return { ok: false, error: "unsupported_alg" };
  } catch {
    return { ok: false, error: "invalid_header" };
  }
  try {
    const claims = JSON.parse(base64UrlDecode(claimsB64).toString());
    const now = Math.floor(Date.now() / 1000);
    if (checkExp && typeof claims.exp === "number" && now > claims.exp) {
      return { ok: false, error: "expired" };
    }
    if (typeof claims.nbf === "number" && now < claims.nbf) {
      return { ok: false, error: "not_yet_valid" };
    }
    return { ok: true, payload: claims.payload };
  } catch {
    return { ok: false, error: "invalid_claims" };
  }
}
function jweEncrypt(payload, secret, kid = "fleet_key") {
  const header = { alg: "dir", enc: "A256GCM", kid, typ: "JWT" };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const now = Math.floor(Date.now() / 1000);
  const plaintext = JSON.stringify({
    payload,
    iat: now,
    exp: now + 300
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(Buffer.from(headerB64, "ascii"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${headerB64}..${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}.${base64UrlEncode(tag)}`;
}
function jweDecrypt(compact, secret, opts = {}) {
  const checkExp = opts.checkExp !== false;
  const parts = compact.split(".");
  if (parts.length !== 5)
    return { ok: false, error: "invalid_format" };
  const [headerB64, _encKeyB64, ivB64, ciphertextB64, tagB64] = parts;
  try {
    const header = JSON.parse(base64UrlDecode(headerB64).toString());
    if (header.alg !== "dir" || header.enc !== "A256GCM") {
      return { ok: false, error: "unsupported_alg_enc" };
    }
  } catch {
    return { ok: false, error: "invalid_header" };
  }
  try {
    const iv = base64UrlDecode(ivB64);
    const ciphertext = base64UrlDecode(ciphertextB64);
    const tag = base64UrlDecode(tagB64);
    const decipher = createDecipheriv("aes-256-gcm", secret, iv);
    decipher.setAAD(Buffer.from(headerB64, "ascii"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const claims = JSON.parse(plaintext);
    const now = Math.floor(Date.now() / 1000);
    if (checkExp && typeof claims.exp === "number" && now > claims.exp) {
      return { ok: false, error: "expired" };
    }
    return { ok: true, payload: claims.payload };
  } catch {
    return { ok: false, error: "decrypt_failed" };
  }
}
function protect(payload, secret, mode = "sign_encrypt", kid = "fleet_key") {
  switch (mode) {
    case "none":
      return { message: payload, crypto: { mode: "none" } };
    case "sign": {
      const jws = jwsSign(payload, secret, kid);
      return {
        message: payload,
        jws,
        crypto: { mode: "sign", kid, alg: "HS256" }
      };
    }
    case "encrypt": {
      const jwe = jweEncrypt(payload, secret, kid);
      return {
        jwe,
        crypto: { mode: "encrypt", kid, enc: "A256GCM" }
      };
    }
    case "sign_encrypt": {
      const jws = jwsSign(payload, secret, kid);
      const jwe = jweEncrypt({ jws }, secret, kid);
      return {
        jwe,
        crypto: { mode: "sign_encrypt", kid, alg: "HS256", enc: "A256GCM" }
      };
    }
  }
}
function unprotect(envelope, secret) {
  const mode = envelope.crypto?.mode || "none";
  switch (mode) {
    case "none":
      return envelope.message ? { ok: true, payload: envelope.message } : { ok: false, error: "no_message" };
    case "sign":
      if (!envelope.jws)
        return { ok: false, error: "missing_jws" };
      return jwsVerify(envelope.jws, secret);
    case "encrypt":
      if (!envelope.jwe)
        return { ok: false, error: "missing_jwe" };
      return jweDecrypt(envelope.jwe, secret);
    case "sign_encrypt": {
      if (!envelope.jwe)
        return { ok: false, error: "missing_jwe" };
      const decrypted = jweDecrypt(envelope.jwe, secret);
      if (!decrypted.ok)
        return decrypted;
      const inner = decrypted.payload;
      if (!inner.jws)
        return { ok: false, error: "missing_inner_jws" };
      return jwsVerify(inner.jws, secret);
    }
    default:
      return { ok: false, error: `unknown_mode: ${mode}` };
  }
}
function decodeSecret(encoded) {
  return base64UrlDecode(encoded);
}

// src/client.ts
var WebSocket = (() => {
  try {
    return require_ws_bridge();
  } catch {
    return __require("ws");
  }
})();

class RingforgeClient {
  ws = null;
  config;
  handlers;
  refCounter = 0;
  joinRef = null;
  fleetTopic = null;
  heartbeatInterval = null;
  reconnectTimeout = null;
  reconnectAttempts = 0;
  stopped = false;
  agentId = null;
  connectedAt = null;
  pendingReplies = new Map;
  fleetKey = null;
  fleetKeyKid = "fleet_key";
  constructor(config, handlers = {}) {
    this.config = config;
    this.handlers = handlers;
  }
  makeRef() {
    return String(++this.refCounter);
  }
  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
  pushChannel(event, payload = {}) {
    const ref = this.makeRef();
    if (this.fleetTopic) {
      this.send([this.joinRef, ref, this.fleetTopic, event, payload]);
    }
    return ref;
  }
  pushChannelAsync(event, payload = {}, timeoutMs = 1e4) {
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
  connect() {
    this.stopped = false;
    this.fleetKey = null;
    const agentInfo = JSON.stringify({
      name: this.config.agentName
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
      this.heartbeatInterval = setInterval(() => {
        this.send([null, this.makeRef(), "phoenix", "heartbeat", {}]);
      }, 30000);
      this.joinFleet();
    });
    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const [_jRef, ref, _topic, event, payload] = msg;
        this.handleMessage(event, payload, ref);
      } catch {}
    });
    this.ws.on("close", (_code, reason) => {
      this.cleanup();
      this.handlers.onDisconnected?.(reason?.toString() || "closed");
      this.scheduleReconnect();
    });
    this.ws.on("error", () => {});
  }
  disconnect() {
    this.stopped = true;
    this.cleanup();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
  cleanup() {
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
  scheduleReconnect() {
    if (this.stopped)
      return;
    if (this.reconnectTimeout)
      clearTimeout(this.reconnectTimeout);
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    this.reconnectTimeout = setTimeout(() => this.connect(), delay);
  }
  joinFleet() {
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
          state: "online"
        }
      }
    ]);
    this.fetchCryptoKey();
  }
  fetchCryptoKey() {
    if (!this.fleetTopic)
      return;
    this.pushChannelAsync("crypto:key", {}, 8000).then((response) => {
      const p = response?.payload;
      const encodedKey = p?.key || response?.key;
      const kid = p?.kid || "fleet_key";
      if (encodedKey) {
        this.fleetKey = decodeSecret(encodedKey);
        this.fleetKeyKid = kid;
        this.handlers.onCryptoKeyReceived?.(kid);
      }
    }).catch(() => {
      this.fleetKey = null;
    });
  }
  handleMessage(event, payload, ref) {
    const p = payload?.payload || payload;
    switch (event) {
      case "phx_reply":
        this.handleReply(payload, ref);
        break;
      case "presence:roster": {
        const agents = p?.agents || [];
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
        this.handlers.onPresenceJoined?.(p);
        break;
      case "presence:left":
        this.handlers.onPresenceLeft?.(p?.agent_id);
        break;
      case "direct:message":
        this.handleDirectMessage(p);
        break;
      case "crypto:rotated": {
        const encodedKey = p?.key;
        const kid = p?.kid || "fleet_key";
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
      default:
        break;
    }
  }
  handleReply(payload, ref) {
    if (ref && this.pendingReplies.has(ref)) {
      const pending = this.pendingReplies.get(ref);
      this.pendingReplies.delete(ref);
      clearTimeout(pending.timer);
      const status2 = payload?.status;
      if (status2 === "ok") {
        pending.resolve(payload?.response || {});
      } else {
        pending.reject(new Error(`Reply error: ${JSON.stringify(payload?.response || payload).slice(0, 200)}`));
      }
      return;
    }
    const status = payload?.status;
    if (status === "error") {
      const resp = payload?.response;
      if (resp?.reason === "fleet_id_mismatch" && resp?.your_fleet_id) {
        this.config.fleetId = resp.your_fleet_id;
        this.joinFleet();
      }
    }
  }
  handleDirectMessage(p) {
    const from = p?.from;
    let message = p?.message;
    const cryptoMeta = p?.crypto;
    if (cryptoMeta && cryptoMeta.mode !== "none" && this.fleetKey) {
      try {
        const envelope = {
          jws: p?.jws,
          jwe: p?.jwe,
          message,
          crypto: cryptoMeta
        };
        const result = unprotect(envelope, this.fleetKey);
        if (result.ok) {
          message = result.payload;
        }
      } catch {}
    }
    if (message && from) {
      this.handlers.onDirectMessage?.(from, message);
    }
  }
  sendDM(toAgentId, message) {
    const cryptoMode = this.config.cryptoMode || "sign_encrypt";
    if (cryptoMode !== "none" && this.fleetKey) {
      const envelope = protect(message, this.fleetKey, cryptoMode, this.fleetKeyKid);
      this.pushChannel("direct:send", {
        payload: {
          to: toAgentId,
          message,
          jws: envelope.jws,
          jwe: envelope.jwe,
          crypto: envelope.crypto
        }
      });
    } else {
      this.pushChannel("direct:send", {
        payload: { to: toAgentId, message }
      });
    }
  }
  sendText(toAgentId, text) {
    this.sendDM(toAgentId, { type: "text", text });
  }
  broadcastActivity(kind, description, tags = []) {
    this.pushChannel("activity:broadcast", {
      payload: { kind, description, tags }
    });
  }
  updatePresence(update) {
    const payload = {};
    if (update.state)
      payload.state = update.state;
    if (update.task !== undefined)
      payload.task = update.task;
    if (update.model)
      payload.model = update.model;
    if (update.load !== undefined)
      payload.load = update.load;
    this.pushChannel("presence:update", { payload });
  }
  requestRoster() {
    this.pushChannel("presence:roster", {});
  }
  setMemory(key, value) {
    this.pushChannel("memory:set", { payload: { key, value } });
  }
  async getMemoryAsync(key) {
    return this.pushChannelAsync("memory:get", { payload: { key } });
  }
  get isConnected() {
    return this.ws?.readyState === WebSocket.OPEN && this.fleetTopic !== null;
  }
  get currentAgentId() {
    return this.agentId;
  }
  get uptimeMs() {
    return this.connectedAt ? Date.now() - this.connectedAt : 0;
  }
  get hasCrypto() {
    return this.fleetKey !== null;
  }
  get currentFleetId() {
    return this.config.fleetId;
  }
}

// src/context-manager.ts
var DEFAULT_CONFIG = {
  refreshIntervalMs: 5 * 60 * 1000,
  injectContext: true,
  maxContextChars: 4000,
  include: "all"
};

class ContextManager {
  client;
  config;
  context = null;
  refreshTimer = null;
  lastRefreshAt = 0;
  fetchInProgress = false;
  constructor(client, config) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.client = client;
  }
  async start() {
    await this.refreshWithRetry(2);
    if (this.config.refreshIntervalMs > 0) {
      this.refreshTimer = setInterval(() => this.refresh(), this.config.refreshIntervalMs);
    }
  }
  stop() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.context = null;
    this.fetchInProgress = false;
  }
  async refresh() {
    if (!this.client.isConnected || this.fetchInProgress)
      return;
    this.fetchInProgress = true;
    try {
      const response = await this.client.pushChannelAsync("context:sync", { payload: { include: this.config.include } }, 15000);
      const ctx = response?.context || response?.payload?.context || response;
      if (ctx && typeof ctx === "object") {
        this.context = ctx;
        this.lastRefreshAt = Date.now();
      }
    } catch {} finally {
      this.fetchInProgress = false;
    }
  }
  async refreshWithRetry(retries) {
    for (let i = 0;i <= retries; i++) {
      await this.refresh();
      if (this.context)
        return;
      if (i < retries)
        await new Promise((r) => setTimeout(r, 2000));
    }
  }
  getContext() {
    return this.context;
  }
  isStale() {
    if (!this.context)
      return true;
    return Date.now() - this.lastRefreshAt > this.config.refreshIntervalMs * 2;
  }
  buildPromptContext() {
    if (!this.config.injectContext || !this.context)
      return null;
    const parts = ["\u2550\u2550\u2550 RINGFORGE CONTEXT \u2550\u2550\u2550"];
    const a = this.context.agent;
    if (a) {
      parts.push(`
\u2500\u2500 YOUR STATUS \u2500\u2500`);
      parts.push(`Agent: ${a.name} (${a.agent_id})`);
      if (a.role) {
        const rname = a.role.name || a.role.slug || "assigned";
        parts.push(`Role: ${rname}`);
      }
      if (a.squad_id)
        parts.push(`Squad: ${a.squad_id}`);
      if (a.capabilities?.length)
        parts.push(`Capabilities: ${a.capabilities.join(", ")}`);
      const t = a.tasks;
      if (t.count > 0) {
        parts.push(`
Tasks: ${t.count} total, ${t.in_progress} in progress`);
        if (t.next) {
          parts.push(`\u25B6 NEXT: [${t.next.task_id}] ${t.next.title} (${t.next.priority})`);
          if (t.next.description)
            parts.push(`  ${t.next.description.slice(0, 200)}`);
        }
        const active = t.queue.filter((tk) => tk.lane === "in_progress");
        if (active.length > 0) {
          parts.push("Active:");
          for (const tk of active.slice(0, 5)) {
            const pct = tk.progress ? ` (${tk.progress}%)` : "";
            parts.push(`  \u2022 [${tk.task_id}] ${tk.title} \u2014 ${tk.priority}${pct}`);
            if (tk.context_refs?.length)
              parts.push(`    refs: ${tk.context_refs.join(", ")}`);
          }
        }
        const ready = t.queue.filter((tk) => tk.lane === "ready");
        if (ready.length > 0) {
          parts.push("Ready to pick up:");
          for (const tk of ready.slice(0, 3)) {
            parts.push(`  \u2022 [${tk.task_id}] ${tk.title} \u2014 ${tk.priority}`);
          }
        }
        const blocked = t.queue.filter((tk) => tk.lane === "blocked");
        if (blocked.length > 0) {
          parts.push("\u26A0 Blocked:");
          for (const tk of blocked.slice(0, 3)) {
            const by = tk.blocked_by?.join(", ") || "unknown";
            parts.push(`  \u2022 [${tk.task_id}] ${tk.title} \u2014 blocked by: ${by}`);
          }
        }
      } else {
        parts.push(`
No tasks assigned. Check squad/fleet boards or ask for work.`);
      }
      if (a.instructions)
        parts.push(`
${a.instructions}`);
    }
    const s = this.context.squad;
    if (s) {
      parts.push(`
\u2500\u2500 SQUAD: ${s.squad_id} \u2500\u2500`);
      const st = s.stats;
      parts.push(`Tasks: ${st.total_tasks} total | ${st.in_progress} active | ${st.blocked} blocked | ${st.review} review`);
      if (st.blocked > 0) {
        const blockedTasks = Object.values(s.board || {}).flatMap((lane) => lane.tasks || []).filter((t) => t.lane === "blocked");
        if (blockedTasks.length > 0) {
          parts.push("\u26A0 Squad blocked:");
          for (const t of blockedTasks.slice(0, 3)) {
            parts.push(`  \u2022 [${t.task_id}] ${t.title}`);
          }
        }
      }
      const online = s.members.filter((m) => m.state === "online");
      if (online.length > 0) {
        parts.push(`Team: ${online.map((m) => `${m.name}${m.role ? ` (${m.role})` : ""}`).join(", ")}`);
      }
      if (s.instructions)
        parts.push(s.instructions);
    }
    const f = this.context.fleet;
    if (f) {
      parts.push(`
\u2500\u2500 FLEET \u2500\u2500`);
      const total = Object.values(f.lanes || {}).reduce((a2, b) => a2 + b, 0);
      parts.push(`Board: ${total} tasks across ${Object.keys(f.lanes || {}).length} lanes`);
      if (f.urgent_unassigned?.length > 0) {
        parts.push("\uD83D\uDD34 Urgent unassigned:");
        for (const t of f.urgent_unassigned.slice(0, 3)) {
          parts.push(`  \u2022 [${t.task_id}] ${t.title} (${t.priority})`);
        }
      }
      if (f.instructions)
        parts.push(f.instructions);
    }
    const art = this.context.artifacts;
    if (art && (art.mine?.length || art.recent?.length)) {
      parts.push(`
\u2500\u2500 ARTIFACTS \u2500\u2500`);
      if (art.mine?.length) {
        parts.push(`Your artifacts: ${art.mine.map((a2) => `${a2.name} v${a2.version} (${a2.status})`).join(", ")}`);
      }
      if (art.recent?.length) {
        parts.push(`Recent fleet: ${art.recent.map((a2) => `${a2.name} by ${a2.created_by}`).join(", ")}`);
      }
    }
    if (this.context.rules?.instructions) {
      parts.push(`
\u2500\u2500 RULES \u2500\u2500`);
      parts.push(this.context.rules.instructions);
    }
    const notif = this.context.notifications;
    if (notif && notif.unread_count > 0) {
      parts.push(`
\uD83D\uDCEC ${notif.unread_count} unread notification(s)`);
    }
    parts.push(`
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
    let result = parts.join(`
`);
    if (result.length > this.config.maxContextChars) {
      result = result.slice(0, this.config.maxContextChars - 25) + `
... [context truncated]`;
    }
    return result;
  }
}

// src/dm-handler.ts
var DEFAULT_CONFIG2 = {
  replyTimeoutMs: 120000,
  maxPending: 20,
  autoReply: true
};
var SILENT_TOKENS = new Set(["NO_REPLY", "HEARTBEAT_OK", "no_reply", "heartbeat_ok"]);

class DmHandler {
  client;
  config;
  pending = [];
  cleanupTimer = null;
  constructor(client, config) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG2, ...config };
  }
  start() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 30000);
  }
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.pending = [];
  }
  trackIncoming(from, message, eventText) {
    const existing = this.pending.find((p) => p.fromAgentId === from.agent_id && !p.replied && Date.now() - p.injectedAt < 5000);
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
      replied: false
    });
    while (this.pending.length > this.config.maxPending) {
      this.pending.shift();
    }
  }
  handleAgentEnd(messages) {
    if (!this.config.autoReply || !this.client.isConnected)
      return false;
    const pendingDm = this.findMostRecentPending();
    if (!pendingDm)
      return false;
    if (this.turnUsedRingforgeSend(messages)) {
      pendingDm.replied = true;
      return false;
    }
    const reply = this.extractAssistantReply(messages);
    if (!reply)
      return false;
    const trimmed = reply.trim();
    if (SILENT_TOKENS.has(trimmed) || trimmed.length === 0) {
      return false;
    }
    if (trimmed.startsWith("[[reply_to"))
      return false;
    this.client.sendText(pendingDm.fromAgentId, trimmed);
    pendingDm.replied = true;
    return true;
  }
  hasPending() {
    return this.pending.some((p) => !p.replied && !this.isExpired(p));
  }
  getMostRecentPending() {
    return this.findMostRecentPending();
  }
  get pendingCount() {
    return this.pending.filter((p) => !p.replied && !this.isExpired(p)).length;
  }
  findMostRecentPending() {
    for (let i = this.pending.length - 1;i >= 0; i--) {
      const p = this.pending[i];
      if (!p.replied && !this.isExpired(p))
        return p;
    }
    return null;
  }
  isExpired(p) {
    return Date.now() - p.injectedAt > this.config.replyTimeoutMs;
  }
  extractAssistantReply(messages) {
    for (let i = messages.length - 1;i >= 0; i--) {
      const msg = messages[i];
      if (!msg)
        continue;
      if (msg.role !== "assistant")
        continue;
      if (typeof msg.content === "string" && msg.content.trim()) {
        return msg.content.trim();
      }
      if (Array.isArray(msg.content)) {
        const textParts = [];
        let hasToolUse = false;
        for (const part of msg.content) {
          const p = part;
          if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
            textParts.push(p.text.trim());
          }
          if (p.type === "tool_use")
            hasToolUse = true;
        }
        if (textParts.length > 0)
          return textParts.join(`
`);
        if (hasToolUse)
          continue;
      }
      if (msg.tool_calls && !msg.content)
        continue;
      break;
    }
    return null;
  }
  turnUsedRingforgeSend(messages) {
    for (let i = messages.length - 1;i >= 0; i--) {
      const msg = messages[i];
      if (!msg)
        continue;
      const role = msg.role;
      if (role !== "assistant" && role !== "tool")
        break;
      if (role === "assistant") {
        const toolCalls = msg.tool_calls;
        if (toolCalls?.some((tc) => tc.function?.name === "ringforge_send")) {
          return true;
        }
        if (Array.isArray(msg.content)) {
          if (msg.content.some((p) => p.type === "tool_use" && p.name === "ringforge_send")) {
            return true;
          }
        }
      }
    }
    return false;
  }
  cleanup() {
    const now = Date.now();
    this.pending = this.pending.filter((p) => {
      if (!p.replied && now - p.injectedAt < this.config.replyTimeoutMs)
        return true;
      if (p.replied && now - p.injectedAt < 1e4)
        return true;
      return false;
    });
  }
}

// src/tools.ts
var lastRoster = [];
var pendingMessages = [];
var MAX_PENDING = 50;
function updateRoster(agents) {
  lastRoster = agents;
}
function pushIncomingMessage(from, message) {
  pendingMessages.push({
    from: from.agent_id,
    fromName: from.name || from.agent_id,
    message,
    ts: Date.now()
  });
  if (pendingMessages.length > MAX_PENDING) {
    pendingMessages = pendingMessages.slice(-MAX_PENDING);
  }
}
function text(t) {
  return { content: [{ type: "text", text: t }], details: { text: t } };
}
function createRingforgeTools(client, ctxMgr) {
  const notConnected = () => text("Not connected to Ringforge mesh.");
  return [
    {
      name: "ringforge_roster",
      label: "Ringforge Roster",
      description: "List agents currently online in the Ringforge fleet. Returns agent IDs, names, states, and capabilities.",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => {
        client.requestRoster();
        if (lastRoster.length === 0) {
          return text("No agents in roster yet. Fleet may be empty or roster pending.");
        }
        const lines = lastRoster.map((a) => `- ${a.name || a.agent_id} (${a.agent_id}) \u2014 ${a.state}${a.model ? ` [${a.model}]` : ""}${a.task ? `, task: ${a.task}` : ""}, caps: [${(a.capabilities || []).join(", ")}]`);
        return text(`Fleet roster (${lastRoster.length} agents):
${lines.join(`
`)}`);
      }
    },
    {
      name: "ringforge_send",
      label: "Ringforge Send",
      description: 'Send a DM to another agent. Text or structured: {"type":"task_request","task":"name","description":"..."}',
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Target agent ID (e.g. ag_xxx)" },
          message: {
            type: "string",
            description: "Text message or JSON structured payload"
          }
        },
        required: ["agent_id", "message"]
      },
      execute: async (_id, params) => {
        if (!client.isConnected)
          return notConnected();
        let msg;
        try {
          msg = JSON.parse(params.message);
          if (!msg.type)
            msg.type = "text";
        } catch {
          msg = { type: "text", text: params.message };
        }
        client.sendDM(params.agent_id, msg);
        return text(`Sent to ${params.agent_id}: ${JSON.stringify(msg).slice(0, 200)}`);
      }
    },
    {
      name: "ringforge_inbox",
      label: "Ringforge Inbox",
      description: "Check incoming messages from other agents. Returns unread and clears inbox.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Max messages (default 10)" } },
        required: []
      },
      execute: async (_id, params) => {
        const limit = params.limit || 10;
        const msgs = pendingMessages.splice(0, limit);
        if (msgs.length === 0)
          return text("No new messages in Ringforge inbox.");
        const lines = msgs.map((m) => {
          const age = Math.floor((Date.now() - m.ts) / 1000);
          const body = m.message.type === "text" ? m.message.text : JSON.stringify(m.message);
          return `[${age}s ago] ${m.fromName}: ${body}`;
        });
        const more = pendingMessages.length > 0 ? `
(${pendingMessages.length} more in queue)` : "";
        return text(`${msgs.length} message(s):
${lines.join(`
`)}${more}`);
      }
    },
    {
      name: "ringforge_activity",
      label: "Ringforge Activity",
      description: "Broadcast an activity event to the fleet.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "Kind: task_started, task_completed, task_failed, discovery, question, alert, custom"
          },
          description: { type: "string", description: "Activity description" },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags" }
        },
        required: ["kind", "description"]
      },
      execute: async (_id, params) => {
        if (!client.isConnected)
          return notConnected();
        client.broadcastActivity(params.kind, params.description, params.tags || []);
        return text(`Activity broadcast: [${params.kind}] ${params.description}`);
      }
    },
    {
      name: "ringforge_presence",
      label: "Ringforge Presence",
      description: "Update your presence state (online, busy, away) with optional task.",
      parameters: {
        type: "object",
        properties: {
          state: { type: "string", description: "State: online, busy, away" },
          task: { type: "string", description: "Optional task description" }
        },
        required: ["state"]
      },
      execute: async (_id, params) => {
        if (!client.isConnected)
          return notConnected();
        client.updatePresence({ state: params.state, task: params.task });
        return text(`Presence: ${params.state}${params.task ? ` (${params.task})` : ""}`);
      }
    },
    {
      name: "ringforge_memory",
      label: "Ringforge Memory",
      description: "Read or write shared fleet memory (key-value store).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "set or get" },
          key: { type: "string", description: "Memory key" },
          value: { type: "string", description: "Value to set (for set action)" }
        },
        required: ["action", "key"]
      },
      execute: async (_id, params) => {
        if (!client.isConnected)
          return notConnected();
        if (params.action === "set") {
          client.setMemory(params.key, params.value || "");
          return text(`Memory set: ${params.key}`);
        }
        if (params.action === "get") {
          try {
            const reply = await client.getMemoryAsync(params.key);
            const val = reply?.value ?? reply?.result ?? reply;
            return text(`Memory[${params.key}]: ${JSON.stringify(val).slice(0, 1000)}`);
          } catch (err) {
            return text(`Memory get failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return text(`Unknown action: ${params.action}. Use 'set' or 'get'.`);
      }
    },
    {
      name: "ringforge_kanban",
      label: "Ringforge Kanban",
      description: "Query the kanban board at agent, squad, or fleet level. Shows tasks, priorities, blockers.",
      parameters: {
        type: "object",
        properties: {
          level: {
            type: "string",
            description: "agent (your tasks), squad (team), fleet (all). Default: agent"
          },
          squad_id: { type: "string", description: "Squad ID for squad-level (optional)" }
        },
        required: []
      },
      execute: async (_id, params) => {
        if (!client.isConnected)
          return notConnected();
        try {
          const reply = await client.pushChannelAsync("context:kanban", {
            payload: { level: params.level || "agent", squad_id: params.squad_id }
          });
          const data = reply?.payload || reply;
          return text(formatKanban(data));
        } catch (err) {
          return text(`Kanban query failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    {
      name: "ringforge_context",
      label: "Ringforge Context",
      description: "Get full context: tasks, role, squad, fleet priorities, artifacts, rules. Use when starting work or unsure what to do.",
      parameters: {
        type: "object",
        properties: {
          include: { type: "string", description: "all, agent, squad, fleet. Default: all" }
        },
        required: []
      },
      execute: async (_id, params) => {
        if (ctxMgr) {
          await ctxMgr.refresh();
          const prompt = ctxMgr.buildPromptContext();
          if (prompt)
            return text(prompt);
        }
        if (!client.isConnected)
          return notConnected();
        try {
          const reply = await client.pushChannelAsync("context:sync", {
            payload: { include: params.include || "all" }
          });
          const ctx = reply?.context || reply?.payload?.context || reply;
          return text(JSON.stringify(ctx, null, 2).slice(0, 3000));
        } catch (err) {
          return text(`Context sync failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    {
      name: "ringforge_task_update",
      label: "Ringforge Task Update",
      description: "Update a kanban task: move lanes, update progress, or complete. Use to track work.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID (e.g. T-001)" },
          action: { type: "string", description: "move, update, or complete" },
          lane: {
            type: "string",
            description: "Target lane for move: backlog, ready, in_progress, blocked, review, done"
          },
          progress: { type: "number", description: "Progress percentage (0-100)" },
          reason: { type: "string", description: "Reason (shown in history)" }
        },
        required: ["task_id", "action"]
      },
      execute: async (_id, params) => {
        if (!client.isConnected)
          return notConnected();
        try {
          const eventMap = {
            move: "kanban:move",
            update: "kanban:update",
            complete: "kanban:move"
          };
          const event = eventMap[params.action] || "kanban:update";
          const payload = { task_id: params.task_id };
          if (params.action === "move" || params.action === "complete") {
            payload.lane = params.action === "complete" ? "done" : params.lane;
          }
          if (params.progress !== undefined)
            payload.progress = params.progress;
          if (params.reason)
            payload.reason = params.reason;
          const reply = await client.pushChannelAsync(event, { payload });
          return text(`Task ${params.task_id}: ${params.action} \u2192 ${JSON.stringify(reply).slice(0, 300)}`);
        } catch (err) {
          return text(`Task update failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  ];
}
function formatKanban(data) {
  const level = data.level || "unknown";
  const lines = [`Kanban (${level}):`];
  if (level === "agent") {
    const tasks = data.tasks || [];
    const next = data.next;
    if (next) {
      lines.push(`
\u25B6 NEXT: [${next.task_id}] ${next.title} (${next.priority})`);
      if (next.description)
        lines.push(`  ${next.description.slice(0, 200)}`);
    }
    if (tasks.length === 0) {
      lines.push("No tasks in your queue.");
    } else {
      const byLane = {};
      for (const t of tasks) {
        (byLane[t.lane || "unknown"] ??= []).push(t);
      }
      for (const [lane, lt] of Object.entries(byLane)) {
        lines.push(`
${lane.toUpperCase()} (${lt.length}):`);
        for (const t of lt.slice(0, 5)) {
          const pct = t.progress ? ` (${t.progress}%)` : "";
          lines.push(`  \u2022 [${t.task_id}] ${t.title} \u2014 ${t.priority}${pct}`);
        }
      }
    }
  } else {
    const board = data.board || {};
    const stats = data.stats;
    if (stats && Object.keys(stats).length)
      lines.push(`Stats: ${JSON.stringify(stats)}`);
    for (const [lane, ld] of Object.entries(board)) {
      const count = ld?.count || 0;
      const tasks = ld?.tasks || [];
      lines.push(`
${lane.toUpperCase()} (${count}):`);
      for (const t of tasks.slice(0, 5)) {
        const who = t.assigned_to ? ` \u2192 ${t.assigned_to}` : " [unassigned]";
        lines.push(`  \u2022 [${t.task_id}] ${t.title} \u2014 ${t.priority}${who}`);
      }
      if (count > 5)
        lines.push(`  ... +${count - 5} more`);
    }
  }
  return lines.join(`
`);
}

// index.src.ts
function resolveConfig(pluginConfig, agentName) {
  if (!pluginConfig || pluginConfig.enabled === false)
    return null;
  const server = pluginConfig.server;
  const apiKey = pluginConfig.apiKey;
  if (!server || !apiKey)
    return null;
  return {
    server,
    apiKey,
    fleetId: pluginConfig.fleetId || "default",
    agentName: pluginConfig.agentName || agentName || `openclaw-${Math.random().toString(36).slice(2, 8)}`,
    framework: "openclaw",
    capabilities: pluginConfig.capabilities || [],
    model: pluginConfig.model || undefined,
    cryptoMode: pluginConfig.cryptoMode || "sign_encrypt"
  };
}
function resolveModel(api) {
  try {
    const cfg = api.config;
    if (typeof cfg.model === "string")
      return cfg.model;
    const rt = cfg.agentRuntime;
    if (typeof rt?.model === "string")
      return rt.model;
    const models = cfg.models;
    if (typeof models?.default === "string")
      return models.default;
    const fresh = api.runtime.config.loadConfig();
    if (typeof fresh?.model === "string")
      return fresh.model;
    return null;
  } catch {
    return null;
  }
}
function formatDmEvent(from, message) {
  const who = `${from.name || from.agent_id} (${from.agent_id})`;
  const type = message.type || "text";
  switch (type) {
    case "text":
      return `[Ringforge DM from ${who}] ${message.text}`;
    case "task_request":
      return `[Ringforge Task from ${who}] "${message.task}": ${message.description || ""}${message.priority === "high" ? " \u26A1 HIGH" : ""}`;
    case "query":
      return `[Ringforge Query from ${who}] ${message.question}`;
    case "status_request":
      return `[Ringforge Status Request from ${who}] Requesting status.`;
    case "data":
      return `[Ringforge Data from ${who}] "${message.label}": ${JSON.stringify(message.payload).slice(0, 500)}`;
    case "task_result":
      return `[Ringforge Result from ${who}] ref=${message.ref}: ${JSON.stringify(message.result).slice(0, 500)}`;
    default:
      return `[Ringforge DM from ${who}] [${type}]: ${JSON.stringify(message).slice(0, 500)}`;
  }
}
var ringforgePlugin = {
  id: "ringforge",
  name: "Ringforge",
  description: "Connect to a Ringforge agent mesh fleet",
  version: "0.4.0",
  configSchema: {
    parse(value) {
      return value && typeof value === "object" ? value : {};
    },
    uiHints: {
      enabled: { label: "Enabled", help: "Enable Ringforge mesh" },
      server: { label: "Server URL", placeholder: "wss://ringforge.wejoona.com" },
      apiKey: { label: "API Key", sensitive: true, placeholder: "rf_live_..." },
      fleetId: { label: "Fleet ID" },
      agentName: { label: "Agent Name", help: "Display name in the mesh" },
      capabilities: { label: "Capabilities", help: "Comma-separated" },
      autoReply: {
        label: "Auto-Reply",
        help: "Auto-send LLM replies to DM senders (default: true)"
      },
      cryptoMode: {
        label: "Crypto Mode",
        help: "none | sign | encrypt | sign_encrypt (default: sign_encrypt)"
      },
      contextRefreshMs: {
        label: "Context Refresh (ms)",
        help: "How often to refresh context (default: 300000)"
      },
      maxContextChars: {
        label: "Max Context Chars",
        help: "Max chars for context injection (default: 4000)"
      }
    }
  },
  register(api) {
    const config = resolveConfig(api.pluginConfig, api.config?.identity?.agentName || api.name);
    if (!config) {
      api.logger.info("Ringforge: disabled (need server + apiKey)");
      return;
    }
    const pc = api.pluginConfig || {};
    const autoReply = pc.autoReply !== false;
    const refreshMs = Number(pc.contextRefreshMs) || 5 * 60 * 1000;
    const maxCtxChars = Number(pc.maxContextChars) || 4000;
    let lastModel = null;
    const client = new RingforgeClient(config, {
      onConnected: (agentId) => {
        api.logger.info(`Ringforge: connected as ${config.agentName} (${agentId})`);
      },
      onDisconnected: (reason) => {
        api.logger.info(`Ringforge: disconnected (${reason})`);
      },
      onDirectMessage: (from, message) => {
        const name = from.name || from.agent_id;
        const preview = message.type === "text" ? message.text : JSON.stringify(message).slice(0, 80);
        api.logger.info(`Ringforge DM from ${name}: ${preview}`);
        pushIncomingMessage(from, message);
        const injection = message.injection || "immediate";
        if (injection === "silent")
          return;
        const eventText = formatDmEvent(from, message);
        try {
          api.runtime.system.enqueueSystemEvent(eventText, { sessionKey: "agent:main:main" });
          dmHandler.trackIncoming(from, message, eventText);
          api.logger.info(`Ringforge: injected DM, ${dmHandler.pendingCount} pending`);
        } catch (err) {
          api.logger.warn(`Ringforge: DM injection failed: ${err}`);
        }
      },
      onRoster: (agents) => {
        updateRoster(agents);
        api.logger.info(`Ringforge: roster ${agents.length} agents`);
      },
      onPresenceJoined: (a) => api.logger.info(`Ringforge: ${a.name || a.agent_id} joined`),
      onPresenceLeft: (id) => api.logger.info(`Ringforge: ${id} left`),
      onActivity: (a) => api.logger.info(`Ringforge: [${a.kind}] ${a.description}`),
      onCryptoKeyReceived: (kid) => api.logger.info(`Ringforge: crypto key received (${kid})`),
      onCryptoKeyRotated: (kid) => api.logger.info(`Ringforge: crypto key rotated (${kid})`)
    });
    const dmHandler = new DmHandler(client, { autoReply });
    const ctxMgr = new ContextManager(client, {
      refreshIntervalMs: refreshMs,
      injectContext: true,
      maxContextChars: maxCtxChars
    });
    const model = resolveModel(api);
    if (model) {
      config.model = model;
      lastModel = model;
      api.logger.info(`Ringforge: model ${model}`);
    }
    api.on("before_agent_start", (_event, _ctx) => {
      const m = resolveModel(api);
      if (m && m !== lastModel) {
        lastModel = m;
        if (client.isConnected) {
          client.updatePresence({ model: m, state: "busy" });
        }
      }
      const prompt = ctxMgr.buildPromptContext();
      if (prompt)
        return { prependContext: prompt };
      return;
    });
    api.on("agent_end", (event, _ctx) => {
      if (!dmHandler.hasPending())
        return;
      try {
        if (dmHandler.handleAgentEnd(event.messages || [])) {
          api.logger.info("Ringforge: auto-replied to DM");
        }
      } catch (err) {
        api.logger.warn(`Ringforge: agent_end DM error: ${err}`);
      }
    });
    const tools = createRingforgeTools(client, ctxMgr);
    for (const tool of tools) {
      api.registerTool(tool, { name: tool.name });
    }
    api.registerCommand({
      name: "ringforge",
      description: "Ringforge mesh status",
      handler: () => {
        const s = client.isConnected ? "\uD83D\uDFE2 Connected" : "\uD83D\uDD34 Disconnected";
        const id = client.currentAgentId || "\u2014";
        const up = Math.floor(client.uptimeMs / 1000);
        const pending = dmHandler.pendingCount;
        const ctx = ctxMgr.isStale() ? "stale" : "fresh";
        const tasks = ctxMgr.getContext()?.agent?.tasks?.count ?? "?";
        const crypto = client.hasCrypto ? "\uD83D\uDD12 on" : "off";
        return {
          text: [
            `Ringforge: ${s}`,
            `Agent: ${config.agentName} (${id})`,
            `Fleet: ${config.fleetId}`,
            `Uptime: ${up}s`,
            `Auto-reply: ${autoReply ? "on" : "off"}`,
            `Pending DMs: ${pending}`,
            `Context: ${ctx} (${tasks} tasks)`,
            `Crypto: ${crypto}`
          ].join(`
`)
        };
      }
    });
    api.registerService({
      id: "ringforge-mesh",
      start: async () => {
        api.logger.info(`Ringforge: connecting to ${config.server}...`);
        client.connect();
        dmHandler.start();
        setTimeout(async () => {
          if (client.isConnected) {
            try {
              await ctxMgr.start();
              api.logger.info("Ringforge: context manager active");
            } catch (err) {
              api.logger.warn(`Ringforge: context start failed: ${err}`);
            }
          }
        }, 5000);
      },
      stop: () => {
        api.logger.info("Ringforge: shutting down");
        ctxMgr.stop();
        dmHandler.stop();
        client.disconnect();
      }
    });
  }
};
var index_src_default = ringforgePlugin;
export {
  index_src_default as default
};
