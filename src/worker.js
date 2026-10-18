import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import WebSocket from "ws";

const gatewayUrl = process.env.UTILS_BROWSER_WORKER_URL;
const workerToken = process.env.UTILS_BROWSER_WORKER_TOKEN;
const mcpUrl = process.env.PLAYWRIGHT_MCP_URL ?? "http://localhost:8931/mcp";
const maxSeconds = Number.parseInt(process.env.WORKER_MAX_SECONDS ?? "20400", 10);
const renewalLeadSeconds = Number.parseInt(process.env.WORKER_RENEWAL_LEAD_SECONDS ?? "900", 10);
const githubToken = process.env.GITHUB_TOKEN;
const githubRepository = process.env.GITHUB_REPOSITORY;
const githubRef = process.env.GITHUB_REF_NAME ?? "main";
const githubRunId = process.env.GITHUB_RUN_ID;
const stateFile = process.env.BROWSER_WORKER_STATE_FILE ?? "browser-worker-state/storage-state.json";
const initialStorageStateJson = process.env.BROWSER_WORKER_INITIAL_STORAGE_STATE_JSON;

if (!gatewayUrl || !workerToken) {
  throw new Error("UTILS_BROWSER_WORKER_URL and UTILS_BROWSER_WORKER_TOKEN are required");
}
if (!Number.isFinite(maxSeconds) || maxSeconds < 60 || maxSeconds > 21000) {
  throw new Error("WORKER_MAX_SECONDS must be between 60 and 21000");
}
if (!Number.isFinite(renewalLeadSeconds) || renewalLeadSeconds < 60 || renewalLeadSeconds >= maxSeconds) {
  throw new Error("WORKER_RENEWAL_LEAD_SECONDS must be at least 60 and less than WORKER_MAX_SECONDS");
}
if (!githubToken || !githubRepository || !githubRunId) {
  throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_RUN_ID are required for worker self-renewal");
}

const workerId = randomUUID();
let shuttingDown = false;
let reconnectTimer;
let renewalTimer;
let renewalRetryTimer;
let renewalTriggered = false;
let gateway;
let gatewayKeepaliveTimer;
let gatewayPongAt = 0;
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
    "--caps=storage",
    "--user-data-dir", process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? ".browser-worker-profile",
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

function parseJsonRpcBody(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function callUpstreamTool(name, arguments_) {
  const sessionId = await ensureUpstreamInitialized();
  const response = await postMcp({
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "tools/call",
    params: { name, arguments: arguments_ },
  }, sessionId);
  if (response.status >= 400) {
    throw new Error(`Playwright MCP tool ${name} failed (${response.status}): ${response.body || "empty response"}`);
  }
  const parsed = parseJsonRpcBody(response.body);
  if (parsed?.error) {
    throw new Error(`Playwright MCP tool ${name} failed: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  }
  return parsed;
}

async function restoreStorageState() {
  const existingState = await fs.stat(stateFile).then(() => true).catch(() => false);
  if (!existingState && initialStorageStateJson) {
    let parsed;
    try {
      parsed = JSON.parse(initialStorageStateJson);
    } catch (error) {
      throw new Error(`BROWSER_WORKER_INITIAL_STORAGE_STATE_JSON is not valid JSON: ${error instanceof Error ? error.message : "invalid JSON"}`);
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
      throw new Error("BROWSER_WORKER_INITIAL_STORAGE_STATE_JSON must be a Playwright storage-state object with cookies and origins arrays");
    }
    await fs.mkdir(new URL(".", `file://${process.cwd()}/`), { recursive: true }).catch(() => {});
    await fs.mkdir(stateFile.includes("/") ? stateFile.slice(0, stateFile.lastIndexOf("/")) : ".", { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(parsed), { mode: 0o600 });
    console.log("Seeded initial browser storage state from BROWSER_WORKER_INITIAL_STORAGE_STATE_JSON");
  }

  const stateExistsNow = await fs.stat(stateFile).then(() => true).catch(() => false);
  if (!stateExistsNow) {
    console.log("No persisted browser storage state found; starting with a fresh profile");
    return;
  }

  await callUpstreamTool("browser_set_storage_state", { filename: stateFile });
  console.log(`Restored browser storage state from ${stateFile}`);
}

async function saveStorageState() {
  if (!upstreamInitialized) return;
  try {
    await fs.mkdir(stateFile.includes("/") ? stateFile.slice(0, stateFile.lastIndexOf("/")) : ".", { recursive: true });
    await callUpstreamTool("browser_storage_state", { filename: stateFile });
    console.log(`Saved browser storage state to ${stateFile}`);
  } catch (error) {
    console.error("Failed to save browser storage state:", error instanceof Error ? error.message : error);
  }
}

async function triggerReplacementWorkflow() {
  if (renewalTriggered || shuttingDown) return;
  renewalTriggered = true;
  try {
    await saveStorageState();
    const url = `https://api.github.com/repos/${githubRepository}/actions/workflows/browser-worker.yml/dispatches`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${githubToken}`,
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "signalai-browser-worker",
      },
      body: JSON.stringify({
        ref: githubRef,
        inputs: { source_run_id: githubRunId },
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub workflow dispatch failed (${response.status}): ${body || "empty response"}`);
    }
    console.log(`Triggered replacement Browser Worker workflow for ${githubRepository}@${githubRef} from run ${githubRunId}`);
    setTimeout(() => void shutdown(), 30_000).unref();
  } catch (error) {
    renewalTriggered = false;
    console.error("Failed to trigger replacement Browser Worker workflow:", error instanceof Error ? error.message : error);
    renewalRetryTimer = setTimeout(() => void triggerReplacementWorkflow(), 60_000);
  }
}

function scheduleReplacement() {
  const delayMs = Math.max(60_000, (maxSeconds - renewalLeadSeconds) * 1000);
  renewalTimer = setTimeout(() => {
    console.log(`Worker renewal window reached; starting replacement ${renewalLeadSeconds}s before expiry`);
    void triggerReplacementWorkflow();
  }, delayMs);
  console.log(`Scheduled replacement in ${Math.round(delayMs / 60_000)} minutes`);
}

function stopGatewayKeepalive() {
  if (gatewayKeepaliveTimer) {
    clearInterval(gatewayKeepaliveTimer);
    gatewayKeepaliveTimer = undefined;
  }
}

function startGatewayKeepalive() {
  stopGatewayKeepalive();
  gatewayPongAt = Date.now();
  gatewayKeepaliveTimer = setInterval(() => {
    if (shuttingDown || !gateway || gateway.readyState !== WebSocket.OPEN) return;
    if (Date.now() - gatewayPongAt > 45_000) {
      console.warn("Gateway WebSocket keepalive timed out; terminating connection");
      gateway.terminate();
      return;
    }
    gateway.ping();
  }, 15_000);
}

function connectGateway() {
  if (shuttingDown) return;
  gateway = new WebSocket(gatewayUrl, {
    handshakeTimeout: 10_000,
    maxPayload: 16 * 1024 * 1024,
  });

  gateway.on("open", () => {
    gatewayPongAt = Date.now();
    startGatewayKeepalive();
    gateway.send(JSON.stringify({ type: "worker.hello", workerId, token: workerToken, version: "0.1.0" }));
    console.log(`Gateway WebSocket opened; authenticating worker ${workerId}`);
  });

  gateway.on("pong", () => {
    gatewayPongAt = Date.now();
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
      console.log(`Worker ${workerId} authenticated by Browser MCP gateway`);
      gateway.send(JSON.stringify({ type: "worker.ready", workerId, mcpUrl }));
      return;
    }
    if (message.type === "worker.auth.failed") {
      console.error(`Browser MCP gateway rejected worker authentication: ${message.reason ?? "unknown reason"}`);
      gateway.close(1008, "worker authentication failed");
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
    stopGatewayKeepalive();
    console.warn(`Gateway disconnected (${code}): ${reason.toString()}`);
    if (code === 1013 && reason.toString() === "Worker replaced") {
      console.log("Replacement worker connected; shutting down this worker");
      void shutdown();
      return;
    }
    if (!shuttingDown) reconnectTimer = setTimeout(connectGateway, 1500);
  });

  gateway.on("error", (error) => console.error("Gateway WebSocket error:", error.message));
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  clearTimeout(renewalTimer);
  clearTimeout(renewalRetryTimer);
  stopGatewayKeepalive();
  await saveStorageState();
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
await ensureUpstreamInitialized();
await restoreStorageState();
connectGateway();
scheduleReplacement();
console.log(`Worker ${workerId} started; lifetime ${maxSeconds}s`);
setTimeout(() => {
  console.log("Worker lifecycle limit reached; stopping for scheduled replacement");
  void shutdown();
  setTimeout(() => process.exit(0), 30_000).unref();
}, maxSeconds * 1000).unref();
