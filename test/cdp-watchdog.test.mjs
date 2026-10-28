import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cdpIsHealthy, runCdpWatchdog } from "../src/cdp-watchdog.mjs";

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
