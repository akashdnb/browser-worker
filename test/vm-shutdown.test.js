import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("VM shutdown waits for Chromium to flush session files before stopping desktop", async () => {
  const source = await readFile(new URL("../src/vm.js", import.meta.url), "utf8");
  const shutdown = source.slice(source.indexOf("async function shutdown()"));
  const chromiumStop = shutdown.indexOf("child.kill(\"SIGTERM\")");
  const waitForExit = shutdown.indexOf("waitForChildExit(child, 15_000)");
  const forcedStop = shutdown.indexOf("child.kill(\"SIGKILL\")");
  const desktopStop = shutdown.indexOf("for (const child of [...remainingChildren].reverse())");

  assert.notEqual(chromiumStop, -1);
  assert.notEqual(waitForExit, -1);
  assert.notEqual(forcedStop, -1);
  assert.notEqual(desktopStop, -1);
  assert.ok(chromiumStop < waitForExit);
  assert.ok(waitForExit < forcedStop);
  assert.ok(forcedStop < desktopStop);
  assert.match(source, /"--restore-last-session"/);
});

test("VM profile checkpoint uses a stable workspace profile path", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /PLAYWRIGHT_MCP_USER_DATA_DIR: \$\{\{ github\.workspace \}\}\/browser-worker-state\/live-profile/);
  assert.match(workflow, /BROWSER_WORKER_CHECKPOINT_SECONDS: "60"/);
});
