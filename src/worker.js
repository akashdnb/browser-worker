import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import net from "node:net";
import WebSocket from "ws";

const gatewayUrl = process.env.UTILS_BROWSER_WORKER_URL;
const workerToken = process.env.UTILS_BROWSER_WORKER_TOKEN;
const mcpUrl = process.env.PLAYWRIGHT_MCP_URL ?? "http://localhost:8931/mcp";
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
let upstreamSessionId = null;
let upstreamInitialized = false;
let upstreamInitializePromise = null;

const playwright = spawn(
  process.execPath,
  [
    "node_modules/@playwright/mcp/cli.js",
    "--host", "localhost",
    "--port", "8931",
    "--allowed-hosts", "localhost:8931",
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
  const url = new URL(mcpUrl);
  const host = url.hostname;
  const port = Number.parseInt(url.port || "80", 10);
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    if (playwright.exitCode !== null) throw new Error("Playwright MCP process exited during startup");
    try {
      const addresses = await dns.lookup(host, { all: true });
      for (const { address, family } of addresses) {
        try {
          await new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: address, port, family });
            const timer = setTimeout(() => {
              socket.destroy();
              reject(new Error("connection timeout"));
            }, 1500);
            socket.once("connect", () => {
              clearTimeout(timer);
              socket.end();
              resolve();
            });
            socket.once("error", (error) => {
              clearTimeout(timer);
              socket.destroy();
              reject(error);
            });
          });
          console.log(`Playwright MCP TCP listener ready on ${address}:${port}`);
          return;
        } catch {
          // Try the next loopback address before waiting for the next probe.
        }
      }
    } catch {
      // DNS may not be ready yet; retry below.
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Timed out waiting for Playwright MCP TCP listener at ${host}:${port}`);
}

async function postMcp(payload, sessionId = null) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (payload.method !== "initialize") {
    headers["mcp-protocol-version"] = "2025-06-18";
  }
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  return {
    status: response.status,
    contentType,
    body,
    sessionId: response.headers.get("mcp-session-id"),
    protocolVersion: response.headers.get("mcp-protocol-version"),
  };
}

async function ensureUpstreamInitialized() {
  if (upstreamInitialized) return upstreamSessionId;
  if (upstreamInitializePromise) return upstreamInitializePromise;

  upstreamInitializePromise = (async () => {
    const initializeResponse = await postMcp({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "utils-browser-worker", version: "0.1.0" },
      },
    });
    if (initializeResponse.status >= 400) {
      throw new Error(`Playwright MCP initialize failed (${initializeResponse.status}): ${initializeResponse.body || "empty response"}`);
    }
    upstreamSessionId = initializeResponse.sessionId;
    if (!upstreamSessionId) {
      throw new Error("Playwright MCP initialize succeeded without an MCP session id");
    }

    const initializedResponse = await postMcp({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }, upstreamSessionId);
    if (initializedResponse.status >= 400) {
      throw new Error(`Playwright MCP initialized notification failed (${initializedResponse.status}): ${initializedResponse.body || "empty response"}`);
    }
    upstreamInitialized = true;
    return upstreamSessionId;
  })();

  try {
    return await upstreamInitializePromise;
  } finally {
    upstreamInitializePromise = null;
  }
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
      let sessionId = upstreamSessionId;
      if (message.payload.method === "initialize") {
        upstreamInitialized = false;
        upstreamSessionId = null;
        sessionId = null;
      } else {
        sessionId = await ensureUpstreamInitialized();
      }

      const response = await postMcp(message.payload, sessionId);
      if (response.sessionId) upstreamSessionId = response.sessionId;
      if (message.payload.method === "initialize" && response.status < 400 && response.sessionId) {
        upstreamSessionId = response.sessionId;
      }
      gateway.send(JSON.stringify({
        type: "mcp.response",
        workerId,
        requestId: message.requestId,
        status: response.status,
        contentType: response.contentType,
        sessionId: response.sessionId,
        protocolVersion: response.protocolVersion,
        body: response.body,
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