import { randomUUID } from "node:crypto";
import { parseWorkerTiming } from "./worker-config.js";
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import net from "node:net";
import WebSocket from "ws";
import { CdpHealthMonitor } from "./cdp-health-monitor.mjs";

const gatewayUrl = process.env.UTILS_BROWSER_WORKER_URL;
const workerToken = process.env.UTILS_BROWSER_WORKER_TOKEN;
const mcpUrl = process.env.PLAYWRIGHT_MCP_URL ?? "http://localhost:8931/mcp";
const cdpEndpoint = process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const cdpTimeoutMs = Number.parseInt(process.env.PLAYWRIGHT_MCP_CDP_TIMEOUT ?? "120000", 10);
const cdpHealthIntervalMs = Number.parseInt(process.env.CDP_HEALTH_CHECK_INTERVAL_MS ?? "5000", 10);
const cdpFailureThreshold = Number.parseInt(process.env.CDP_HEALTH_FAILURE_THRESHOLD ?? "2", 10);
const cdpRecoveryStartupDeadlineMs = Number.parseInt(
  process.env.CDP_RECOVERY_STARTUP_DEADLINE_MS ?? String(cdpTimeoutMs),
  10,
);
const cdpRecoveryBackoffBaseMs = Number.parseInt(process.env.CDP_RECOVERY_BACKOFF_BASE_MS ?? "1000", 10);
const cdpRecoveryBackoffMaxMs = Number.parseInt(process.env.CDP_RECOVERY_BACKOFF_MAX_MS ?? "30000", 10);
const { maxSeconds, renewalLeadSeconds } = parseWorkerTiming(process.env);
const githubToken = process.env.GITHUB_TOKEN;
const githubRepository = process.env.GITHUB_REPOSITORY;
const githubRef = process.env.GITHUB_REF_NAME ?? "main";
const githubRunId = process.env.GITHUB_RUN_ID;

if (!gatewayUrl || !workerToken) {
  throw new Error("UTILS_BROWSER_WORKER_URL and UTILS_BROWSER_WORKER_TOKEN are required");
}
if (!Number.isFinite(maxSeconds) || maxSeconds < 60 || maxSeconds > 21000) {
  throw new Error("WORKER_MAX_SECONDS must be between 60 and 21000");
}
if (!process.env.VM_ID && (!githubToken || !githubRepository || !githubRunId)) {
  throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_RUN_ID are required for legacy worker self-renewal");
}
if (!Number.isFinite(cdpTimeoutMs) || cdpTimeoutMs < 1000) {
  throw new Error("PLAYWRIGHT_MCP_CDP_TIMEOUT must be at least 1000ms");
}
if (!Number.isFinite(cdpHealthIntervalMs) || cdpHealthIntervalMs < 1000) {
  throw new Error("CDP_HEALTH_CHECK_INTERVAL_MS must be at least 1000ms");
}
if (!Number.isFinite(cdpFailureThreshold) || cdpFailureThreshold < 1) {
  throw new Error("CDP_HEALTH_FAILURE_THRESHOLD must be at least 1");
}
if (!Number.isFinite(cdpRecoveryStartupDeadlineMs) || cdpRecoveryStartupDeadlineMs < 1000) {
  throw new Error("CDP_RECOVERY_STARTUP_DEADLINE_MS must be at least 1000ms");
}

const workerId = process.env.VM_ID || process.env.VM_WORKER_ID || randomUUID();
let shuttingDown = false;
let reconnectTimer;
let gatewayReconnectAttempt = 0;
let renewalTimer;
let renewalRetryTimer;
let renewalTriggered = false;
let gateway;
let gatewayKeepaliveTimer;
let gatewayPongAt = 0;
let playwright = null;
let stoppingPlaywright = false;
let playwrightStopPromise = null;
let upstreamReady = false;
let upstreamReadyReason = "Browser backend is starting";
let cdpMonitor = null;
let upstreamSessionId = null;
let upstreamInitialized = false;
let upstreamInitializePromise = null;

// The VM owns Chromium and its persistent profile. Playwright MCP attaches
// to that browser over CDP; it is restarted independently if Chromium or MCP
// becomes unavailable so the gateway WebSocket can stay alive but unready.
const playwrightArgs = [
  "node_modules/@playwright/mcp/cli.js",
  "--host", "localhost",
  "--port", "8931",
  "--allowed-hosts", "localhost:8931",
  "--browser", "chromium",
  "--cdp-endpoint", cdpEndpoint,
  "--cdp-timeout", String(cdpTimeoutMs),
  "--no-sandbox",
  "--caps=storage",
];

function spawnPlaywrightMcp() {
  if (playwright && playwright.exitCode === null && playwright.signalCode === null) {
    throw new Error("Playwright MCP process is already running");
  }
  const child = spawn(process.execPath, playwrightArgs, {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  playwright = child;
  child.once("error", (error) => {
    if (playwright === child) playwright = null;
    if (shuttingDown || stoppingPlaywright) return;
    const reason = `Playwright MCP failed to start: ${error.message}`;
    console.error(reason);
    upstreamReady = false;
    upstreamReadyReason = reason;
    if (cdpMonitor) void cdpMonitor.forceRecovery(reason);
  });
  child.once("exit", (code, signal) => {
    if (playwright === child) playwright = null;
    if (shuttingDown || stoppingPlaywright) return;
    const reason = `Playwright MCP exited unexpectedly (code=${code}, signal=${signal ?? "none"})`;
    console.error(reason);
    upstreamReady = false;
    upstreamReadyReason = reason;
    if (cdpMonitor) void cdpMonitor.forceRecovery(reason);
    else process.exitCode = 1;
  });
  return child;
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopPlaywrightMcp() {
  if (playwrightStopPromise) return playwrightStopPromise;
  const child = playwright;
  if (!child) return;
  stoppingPlaywright = true;
  playwrightStopPromise = (async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        const gracefulExit = waitForChildExit(child, 3000);
        child.kill("SIGTERM");
        if (!(await gracefulExit)) {
          const forcedExit = waitForChildExit(child, 2000);
          child.kill("SIGKILL");
          await forcedExit;
        }
      }
    } finally {
      if (playwright === child) playwright = null;
      stoppingPlaywright = false;
    }
  })();
  try {
    await playwrightStopPromise;
  } finally {
    playwrightStopPromise = null;
  }
}

async function waitForTcpEndpoint(endpoint, label, timeoutMs) {
  const url = new URL(endpoint);
  const host = url.hostname;
  const port = Number.parseInt(url.port || (url.protocol === "https:" ? "443" : "80"), 10);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline && !shuttingDown) {
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
          console.log(`${label} TCP listener ready on ${address}:${port}`);
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
  if (shuttingDown) throw new Error("Worker is shutting down");
  throw new Error(`Timed out waiting for ${label} at ${host}:${port}`);
}

async function waitForMcp(timeoutMs = 90_000) {
  await waitForTcpEndpoint(mcpUrl, "Playwright MCP", timeoutMs);
}

async function waitForCdp(timeoutMs = cdpTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown error";
  while (Date.now() < deadline && !shuttingDown) {
    try {
      const response = await fetch(`${cdpEndpoint.replace(/\/$/, "")}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        const body = await response.text();
        console.log(`Shared Chromium CDP ready at ${cdpEndpoint}: ${body.slice(0, 500)}`);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  if (shuttingDown) throw new Error("Worker is shutting down");
  throw new Error(`Timed out waiting for shared Chromium CDP at ${cdpEndpoint}: ${lastError}`);
}

async function probeCdp() {
  try {
    const response = await fetch(`${cdpEndpoint.replace(/\/$/, "")}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    await response.arrayBuffer();
    return response.ok
      ? { healthy: true }
      : { healthy: false, reason: `CDP returned HTTP ${response.status}` };
  } catch (error) {
    return { healthy: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function postMcp(payload, sessionId = null, timeoutMs = 120_000) {
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
    signal: AbortSignal.timeout(timeoutMs),
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

async function ensureUpstreamInitialized({ deadline = Date.now() + 120_000 } = {}) {
  if (upstreamInitialized) return upstreamSessionId;
  if (upstreamInitializePromise) return upstreamInitializePromise;

  const remainingMs = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Playwright MCP initialization exceeded its startup deadline");
    return remaining;
  };

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
    }, null, remainingMs());
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
    }, upstreamSessionId, remainingMs());
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

async function recoverPlaywrightBackend({ deadline }) {
  upstreamReady = false;
  upstreamInitialized = false;
  upstreamSessionId = null;
  upstreamInitializePromise = null;
  await stopPlaywrightMcp();

  const remainingMs = () => deadline - Date.now();
  if (remainingMs() <= 0) throw new Error("Browser recovery startup deadline expired before CDP became available");
  await waitForCdp(remainingMs());
  if (shuttingDown) throw new Error("Worker is shutting down");

  spawnPlaywrightMcp();
  const mcpTimeoutMs = Math.min(90_000, remainingMs());
  if (mcpTimeoutMs <= 0) throw new Error("Browser recovery startup deadline expired before Playwright MCP became ready");
  await waitForMcp(mcpTimeoutMs);
  if (shuttingDown) throw new Error("Worker is shutting down");

  await ensureUpstreamInitialized({ deadline });
  upstreamReady = true;
  upstreamReadyReason = "";
  console.log(`Playwright MCP recovered and attached to Chromium CDP at ${cdpEndpoint}`);
}

function announceWorkerNotReady(reason) {
  upstreamReady = false;
  upstreamReadyReason = String(reason || "Browser backend is recovering");
  if (gateway?.readyState === WebSocket.OPEN) {
    gateway.send(JSON.stringify({
      type: "worker.not_ready",
      workerId,
      reason: upstreamReadyReason,
      at: Date.now(),
    }));
  }
}

function announceWorkerReady() {
  upstreamReady = true;
  upstreamReadyReason = "";
  if (gateway?.readyState === WebSocket.OPEN) {
    gateway.send(JSON.stringify({ type: "worker.ready", workerId, mcpUrl }));
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

async function triggerReplacementWorkflow() {
  if (renewalTriggered || shuttingDown) return;
  renewalTriggered = true;
  try {
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
    gatewayReconnectAttempt = 0;
    startGatewayKeepalive();
    gateway.send(JSON.stringify({ type: "worker.hello", workerId, token: workerToken, version: "0.2.0" }));
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
      if (upstreamReady) announceWorkerReady();
      else announceWorkerNotReady(upstreamReadyReason);
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
    if (!upstreamReady) {
      gateway.send(JSON.stringify({
        type: "mcp.error",
        workerId,
        requestId: message.requestId,
        error: upstreamReadyReason || "Browser backend is recovering",
      }));
      return;
    }

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
    if (!shuttingDown) {
      const delayMs = Math.min(30_000, 1000 * (2 ** gatewayReconnectAttempt));
      gatewayReconnectAttempt += 1;
      console.warn(`Reconnecting Browser MCP gateway in ${delayMs}ms`);
      reconnectTimer = setTimeout(connectGateway, delayMs);
    }
  });

  gateway.on("error", (error) => console.error("Gateway WebSocket error:", error.message));
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  cdpMonitor?.stop();
  clearTimeout(reconnectTimer);
  clearTimeout(renewalTimer);
  clearTimeout(renewalRetryTimer);
  stopGatewayKeepalive();
  if (gateway?.readyState === WebSocket.OPEN) {
    try {
      gateway.send(JSON.stringify({ type: "worker.stopping", workerId, reason: "Worker stopping" }));
      gateway.close(1000, "worker stopping");
    } catch {
      // Best effort; process is terminating.
    }
  }
  // MCP only owns the HTTP server now; Chromium remains owned by vm.js.
  await stopPlaywrightMcp();
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

await waitForCdp();
spawnPlaywrightMcp();
await waitForMcp();
await ensureUpstreamInitialized();
upstreamReady = true;
upstreamReadyReason = "";
connectGateway();
cdpMonitor = new CdpHealthMonitor({
  probe: probeCdp,
  recover: recoverPlaywrightBackend,
  onNotReady: announceWorkerNotReady,
  onReady: announceWorkerReady,
  intervalMs: cdpHealthIntervalMs,
  failureThreshold: cdpFailureThreshold,
  startupDeadlineMs: cdpRecoveryStartupDeadlineMs,
  backoffBaseMs: cdpRecoveryBackoffBaseMs,
  backoffMaxMs: cdpRecoveryBackoffMaxMs,
});
cdpMonitor.start({ initiallyReady: true });
if (!process.env.VM_ID) scheduleReplacement();
console.log(`Worker ${workerId} started; lifetime ${maxSeconds}s; shared browser=${cdpEndpoint}`);
setTimeout(() => {
  console.log("Worker lifecycle limit reached; stopping for scheduled replacement");
  void shutdown();
  setTimeout(() => process.exit(0), 30_000).unref();
}, maxSeconds * 1000).unref();
