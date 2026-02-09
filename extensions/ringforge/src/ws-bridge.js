"use strict";
class BridgeWebSocket {
  constructor(url) {
    this._ws = new globalThis.WebSocket(url);
  }
  get readyState() { return this._ws.readyState; }
  send(data) { this._ws.send(data); }
  close() { this._ws.close(); }
  on(event, fn) {
    if (event === "open") this._ws.addEventListener("open", () => fn());
    else if (event === "message") this._ws.addEventListener("message", (ev) => fn(ev.data));
    else if (event === "close") this._ws.addEventListener("close", (ev) => fn(ev.code, ev.reason));
    else if (event === "error") this._ws.addEventListener("error", () => fn());
  }
}
BridgeWebSocket.OPEN = 1;
BridgeWebSocket.CLOSED = 3;
module.exports = BridgeWebSocket;
module.exports.default = BridgeWebSocket;
