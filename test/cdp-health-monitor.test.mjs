import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { CdpHealthMonitor } from "../src/cdp-health-monitor.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections?.();
  await closed;
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("Timed out waiting for expected worker state");
}

test("marks an open worker socket unready when Chromium exits, then readies it after CDP returns", { timeout: 5000 }, async () => {
  const createCdpServer = () => createServer((request, response) => {
    if (request.url === "/json/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ Browser: "Chrome/test" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  let server = createCdpServer();
  const port = await listen(server);
  const endpoint = `http://127.0.0.1:${port}`;
  const gateway = {
    readyState: 1,
    messages: [{ type: "worker.ready", workerId: "legacy-vm" }],
    send(raw) {
      this.messages.push(JSON.parse(raw));
    },
  };
  let upstreamRestarts = 0;

  const probe = async () => {
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(100),
      });
      await response.arrayBuffer();
      return { healthy: response.ok, reason: `CDP returned HTTP ${response.status}` };
    } catch (error) {
      return { healthy: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  const monitor = new CdpHealthMonitor({
    probe,
    recover: async ({ deadline }) => {
      upstreamRestarts += 1;
      while (Date.now() < deadline) {
        const result = await probe();
        if (result.healthy) return;
        await sleep(5);
      }
      throw new Error("CDP did not return before the startup deadline");
    },
    onNotReady: (reason) => gateway.send(JSON.stringify({
      type: "worker.not_ready",
      workerId: "legacy-vm",
      reason,
    })),
    onReady: () => gateway.send(JSON.stringify({
      type: "worker.ready",
      workerId: "legacy-vm",
    })),
    intervalMs: 5,
    failureThreshold: 1,
    startupDeadlineMs: 1000,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
  });

  try {
    monitor.start({ initiallyReady: true });
    await close(server);

    await waitFor(() => gateway.messages.some((message) => message.type === "worker.not_ready"));
    const notReady = gateway.messages.find((message) => message.type === "worker.not_ready");
    assert.match(notReady.reason, /fetch failed|ECONNREFUSED|connect/i);
    assert.equal(gateway.readyState, 1, "worker WebSocket must remain open during CDP recovery");

    server = createCdpServer();
    await listen(server, port);
    await waitFor(() => gateway.messages.filter((message) => message.type === "worker.ready").length >= 2);

    assert.equal(upstreamRestarts, 1);
    assert.equal(gateway.readyState, 1);
    assert.equal(gateway.messages.at(-1).type, "worker.ready");
  } finally {
    monitor.stop();
    await close(server);
  }
});

test("uses capped exponential backoff when the browser backend misses its startup deadline", { timeout: 2000 }, async () => {
  const delays = [];
  let monitor;
  monitor = new CdpHealthMonitor({
    probe: async () => ({ healthy: false, reason: "ECONNREFUSED" }),
    recover: async () => {
      throw new Error("CDP startup deadline exceeded");
    },
    intervalMs: 1000,
    failureThreshold: 1,
    startupDeadlineMs: 1000,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      if (delays.length === 3) monitor.stop();
    },
  });

  await monitor.forceRecovery("Chromium CDP unavailable");
  assert.deepEqual(delays, [5, 10, 20]);
  assert.equal(monitor.isReady, false);
});

test("worker runtime gates MCP requests and reports CDP readiness over the existing gateway socket", { timeout: 2000 }, async () => {
  const worker = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
  assert.match(worker, /new CdpHealthMonitor\(/);
  assert.match(worker, /type: "worker\.not_ready"/);
  assert.match(worker, /type: "worker\.ready"/);
  assert.match(worker, /if \(!upstreamReady\)/);
  assert.match(worker, /cdpMonitor\.forceRecovery\(/);
  assert.match(worker, /gatewayReconnectAttempt/);
  assert.match(worker, /ensureUpstreamInitialized\(\{ deadline \}\)/);
  assert.match(worker, /AbortSignal\.timeout\(timeoutMs\)/);
});
