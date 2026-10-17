import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const gatewayUrl = process.env.UTILS_BROWSER_WORKER_URL;
const workerToken = process.env.UTILS_BROWSER_WORKER_TOKEN;
const mcpUrl = process.env.PLAYWRIGHT_MCP_URL ?? "http://127.0.0.1:8931/mcp";
const maxSeconds = Number.parseInt(process.env.WORKER_MAX_SECONDS ?? "20400", 10);

if (!gatewayUrl || !workerToken) {
  throw new Error("UTILS_BROWSER_WORKER_URL and UTILS_BROWSER_WORKER_TOKEN are required");
}
if (!Number.isFinite(maxSeconds) || maxSeconds < 60 || maxSeconds > 21000) {
  throw new Error("WORKER_MAX_SECONDS must be between 60 and 21000");
}

const workerId = randomUUID();
let shuttingDown = false;
let reconnectTimer;
let gateway;

const playwright = spawn(
  process.execPath,
  [
    "node_modules/@playwright/mcp/cli.js",
    "--host", "127.0.0.1",
    "--port", "8931",
    "--browser", "chromium",
    "--headless",
    "--no-sandbox",
  ],
  { stdio: ["ignore", "inherit", "inherit"], env: process.env },
);

playwright.on("exit", (code, signal) => {
  if (!shuttingDown) {
    console.error(`Playwright MCP exited (code=${code}, signal=${signal})`);
    process.exitCode = 1;
    void shutdown();
  }
});

async function waitForMcp() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (playwright.exitCode !== null) throw new Error("Playwright MCP process exited during startup");
    try {
      const response = await fetch(mcpUrl, { method: "GET", signal: AbortSignal.timeout(1500) });
      if (response.status > 0) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
  throw new Error("Timed out waiting for Playwright MCP to listen on loopback");
}

function connectGateway() {
  if (shuttingDown) return;
  gateway = new WebSocket(gatewayUrl, {
    handshakeTimeout: 10_000,
    maxPayload: 16 * 1024 * 1024,
  });

  gateway.on("open", () => {
    gateway.send(JSON.stringify({ type: "worker.hello", workerId, token: workerToken, version: "0.1.0" }));
    console.log(`Connected to Browser MCP gateway as ${workerId}`);
  });

  gateway.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      console.error("Ignoring invalid JSON from gateway");
      return;
    }
    if (message.type === "worker.auth.ok") {
      gateway.send(JSON.stringify({ type: "worker.ready", workerId, mcpUrl }));
      return;
    }
    if (message.type === "worker.ping") {
      gateway.send(JSON.stringify({ type: "worker.pong", workerId, at: Date.now() }));
      return;
    }
    if (message.type !== "mcp.request" || !message.requestId || !message.payload) return;

    try {
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      if (message.sessionId) headers["mcp-session-id"] = message.sessionId;
      const response = await fetch(mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(message.payload),
        signal: AbortSignal.timeout(120_000),
      });
      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();
      const sessionId = response.headers.get("mcp-session-id");
      gateway.send(JSON.stringify({
        type: "mcp.response",
        workerId,
        requestId: message.requestId,
        status: response.status,
        contentType,
        sessionId,
        body,
      }));
    } catch (error) {
      gateway.send(JSON.stringify({
        type: "mcp.error",
        workerId,
        requestId: message.requestId,
        error: error instanceof Error ? error.message : "MCP request failed",
      }));
    }
  });

  gateway.on("close", (code, reason) => {
    console.warn(`Gateway disconnected (${code}): ${reason.toString()}`);
    if (!shuttingDown) reconnectTimer = setTimeout(connectGateway, 1500);
  });

  gateway.on("error", (error) => console.error("Gateway WebSocket error:", error.message));
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  if (gateway?.readyState === WebSocket.OPEN) {
    try {
      gateway.send(JSON.stringify({ type: "worker.stopping", workerId }));
      gateway.close(1000, "worker stopping");
    } catch {
      // Best effort; process is terminating.
    }
  }
  playwright.kill("SIGTERM");
  setTimeout(() => playwright.kill("SIGKILL"), 3000).unref();
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

await waitForMcp();
connectGateway();
console.log(`Worker ${workerId} started; lifetime ${maxSeconds}s`);
setTimeout(() => {
  console.log("Worker lifecycle limit reached; stopping for scheduled replacement");
  void shutdown();
  setTimeout(() => process.exit(0), 500).unref();
}, maxSeconds * 1000).unref();
