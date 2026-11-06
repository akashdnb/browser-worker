import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("VM restart cleanup handles Playwright's chrome executable name", async () => {
  const vm = await readFile(new URL("../src/vm.js", import.meta.url), "utf8");
  const hook = await readFile(new URL("../src/vm-heartbeat-hook.mjs", import.meta.url), "utf8");
  const watchdog = await readFile(new URL("../src/cdp-watchdog.mjs", import.meta.url), "utf8");
  const supervisor = await readFile(new URL("../src/vm-supervisor.sh", import.meta.url), "utf8");

  assert.match(vm, /\[c\]hrom\(e\|ium\).*remote-debugging-port/);
  assert.match(hook, /trap 'stop_chrome; exit 143' TERM INT/);
  assert.match(watchdog, /\[c\]hrom\(e\|ium\).*remote-debugging-port/);
  assert.match(supervisor, /\[c\]hrom\(e\|ium\).*remote-debugging-port/);
});

test("Chromium startup uses the configured CDP timeout and observes early process exits", async () => {
  const vm = await readFile(new URL("../src/vm.js", import.meta.url), "utf8");
  const watchdog = await readFile(new URL("../src/cdp-watchdog.mjs", import.meta.url), "utf8");
  const tabGuard = await readFile(new URL("../src/chrome-tab-guard.mjs", import.meta.url), "utf8");

  assert.match(vm, /VM_CHROMIUM_STARTUP_TIMEOUT_MS/);
  assert.match(vm, /PLAYWRIGHT_MCP_CDP_TIMEOUT/);
  assert.match(vm, /Chromium process exited before CDP became ready/);
  assert.match(vm, /probeCdp\(cdpStartupTimeoutMs, chromiumProcess\)/);
  assert.match(watchdog, /Math\.max\(150_000, browserStartupTimeoutMs \+ 30_000\)/);
  assert.match(tabGuard, /Math\.max\(120_000, browserStartupTimeoutMs\)/);
});

test("VM starts X11 only after its socket is ready and starts VNC after CDP", async () => {
  const vm = await readFile(new URL("../src/vm.js", import.meta.url), "utf8");
  const start = vm.slice(vm.indexOf("async function startDesktop()"), vm.indexOf("function clampTimeoutSeconds"));

  assert.match(start, /await waitForDisplaySocket\(\);\s*(?:await reportStartup\([^;]+\);\s*)?start\(\["openbox"\]/);
  assert.ok(start.indexOf("await probeCdp(cdpStartupTimeoutMs, chromiumProcess)") < start.indexOf('start([\n    "x11vnc"'));
});
