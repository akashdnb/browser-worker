import WebSocket from "ws";

const originalEmit = WebSocket.prototype.emit;

WebSocket.prototype.emit = function patchedEmit(event, ...args) {
  const result = originalEmit.call(this, event, ...args);

  if (event === "open" && typeof this.url === "string" && this.url.endsWith("/vm-worker") && !this.__vmHeartbeatTimer) {
    this.__vmHeartbeatTimer = setInterval(() => {
      if (this.readyState === WebSocket.OPEN) {
        this.send(JSON.stringify({ type: "vm.heartbeat" }));
      }
    }, 15_000);
    this.__vmHeartbeatTimer.unref?.();
  }

  if (event === "close" && this.__vmHeartbeatTimer) {
    clearInterval(this.__vmHeartbeatTimer);
    this.__vmHeartbeatTimer = undefined;
  }

  return result;
};
