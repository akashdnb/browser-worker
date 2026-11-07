import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("VM relay authenticates before optional BrowserMCP extension bootstrap", async () => {
  const hook = await readFile(new URL("../src/vm-heartbeat-hook.mjs", import.meta.url), "utf8");
  const vm = await readFile(new URL("../src/vm.js", import.meta.url), "utf8");
  const desktop = vm.slice(vm.indexOf("async function startDesktop()"), vm.indexOf("function clampTimeoutSeconds"));
  const authOk = vm.indexOf('message.type === "vm.auth.ok"');
  const bootstrapCall = vm.indexOf("void bootstrapBrowserMcpAfterCdp()", authOk);

  assert.doesNotMatch(hook, /run_bootstrap\(\)/);
  assert.doesNotMatch(desktop, /BROWSER_MCP_BOOTSTRAP_RUNNER/);
  assert.match(vm, /VM_CHROMIUM_CDP_STARTUP_TIMEOUT_MS \?\? "180000"/);
  assert.match(desktop, /if \(!\(await probeCdp\(cdpStartupTimeoutMs\)\)\)/);
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /CDP_WATCHDOG_STARTUP_GRACE_MS: "240000"/);
  assert.match(workflow, /CHROME_TAB_GUARD_STARTUP_GRACE_MS: "180000"/);
  assert.ok(authOk >= 0);
  assert.ok(bootstrapCall > authOk);
  assert.match(vm, /keeping Chromium\/CDP and the VM relay alive/);
});
