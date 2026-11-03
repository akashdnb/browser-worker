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

test("VM starts X11 only after its socket is ready and starts VNC after CDP", async () => {
  const vm = await readFile(new URL("../src/vm.js", import.meta.url), "utf8");
  const start = vm.slice(vm.indexOf("async function startDesktop()"), vm.indexOf("function clampTimeoutSeconds"));

  assert.match(start, /await waitForDisplaySocket\(\);\s*start\(\["openbox"\]/);
  assert.ok(start.indexOf("await probeCdp(30_000)") < start.indexOf('start([\n    "x11vnc"'));
});
