import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("extension bootstrap is deferred and wrapper shutdown reaches Chromium", async () => {
  const hook = await readFile(new URL("../src/vm-heartbeat-hook.mjs", import.meta.url), "utf8");
  const vm = await readFile(new URL("../src/vm.js", import.meta.url), "utf8");

  assert.doesNotMatch(hook, /run_bootstrap\(\)/);
  assert.match(hook, /trap 'stop_chrome; exit 143' TERM INT/);
  assert.match(hook, /wait "\$chrome_pid"/);
  assert.match(vm, /BrowserMCP extension authentication is degraded; keeping Chromium\/CDP and the VM relay alive/);
  assert.match(vm, /void bootstrapBrowserMcpAfterCdp\(\)/);
});
