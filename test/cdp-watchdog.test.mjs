import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cdpIsHealthy, killChromium, runCdpWatchdog } from "../src/cdp-watchdog.mjs";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("cdpIsHealthy detects a live CDP json/version endpoint", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome/test" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(server);

  try {
    assert.equal(await cdpIsHealthy(`http://127.0.0.1:${port}`), true);
  } finally {
    await close(server);
  }
});

test("watchdog invokes recovery after consecutive CDP failures", async () => {
  let restarts = 0;
  let stopped = false;

  await runCdpWatchdog({
    endpoint: "http://127.0.0.1:1",
    intervalMs: 1,
    startupGraceMs: 0,
    threshold: 2,
    onRestart: async () => {
      restarts += 1;
      stopped = true;
    },
    shouldStop: () => stopped,
  });

  assert.equal(restarts, 1);
});

test("watchdog keeps retrying when a recovery attempt fails", async () => {
  let attempts = 0;
  let stopped = false;

  await runCdpWatchdog({
    endpoint: "http://127.0.0.1:1",
    intervalMs: 1,
    startupGraceMs: 0,
    threshold: 1,
    onRestart: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary process-control failure");
      stopped = true;
    },
    shouldStop: () => stopped,
  });

  assert.equal(attempts, 2);
});

test("killChromium escalates to SIGKILL when a Chromium process ignores SIGTERM", async () => {
  const chromium = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { argv0: "chrome --remote-debugging-port=9222", stdio: "ignore" },
  );
  const exited = new Promise((resolve) => chromium.once("exit", resolve));

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("test Chromium process did not start")), 2000);
      const check = setInterval(() => {
        if (chromium.exitCode !== null || chromium.signalCode !== null) {
          clearInterval(check);
          clearTimeout(timer);
          reject(new Error("test Chromium exited before watchdog recovery"));
          return;
        }
        // The process is spawned and has installed its SIGTERM handler.
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      }, 50);
    });
    await killChromium({ graceMs: 150, pollIntervalMs: 25 });
    await exited;
    assert.equal(chromium.signalCode, "SIGKILL");
  } finally {
    if (chromium.exitCode === null && chromium.signalCode === null) chromium.kill("SIGKILL");
  }
});
