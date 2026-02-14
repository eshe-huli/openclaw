// @bun
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = import.meta.require;

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
  sendTyping(toAgentId) {
    this.pushChannel("message:typing", {
      payload: { to: toAgentId }
    });
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
export {
  RingforgeClient
};
