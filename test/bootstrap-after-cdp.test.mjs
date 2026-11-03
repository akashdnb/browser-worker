import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("BrowserMCP bootstrap runs only after Chromium CDP and VNC are ready", async () => {
  const hook = await readFile(new URL("../src/vm-heartbeat-hook.mjs", import.meta.url), "utf8");
  const vm = await readFile(new URL("../src/vm.js", import.meta.url), "utf8");
  const desktop = vm.slice(vm.indexOf("async function startDesktop()"), vm.indexOf("function clampTimeoutSeconds"));
  const vncReady = desktop.indexOf('await waitForPort("127.0.0.1", vncPort, 15_000)');
  const bootstrap = desktop.indexOf("BROWSER_MCP_BOOTSTRAP_RUNNER");

  assert.doesNotMatch(hook, /run_bootstrap\(\)/);
  assert.ok(vncReady >= 0);
  assert.ok(bootstrap > vncReady);
  assert.match(desktop, /if \(!\(await probeCdp\(30_000\)\)\)/);
  assert.match(desktop, /keeping Chromium\/CDP alive/);
});
