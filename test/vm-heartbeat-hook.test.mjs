import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("extension bootstrap failure does not tear down the interactive Chromium session", async () => {
  const hook = await readFile(new URL("../src/vm-heartbeat-hook.mjs", import.meta.url), "utf8");

  assert.match(hook, /BrowserMCP bootstrap failed for extension/);
  assert.match(hook, /Keeping Chromium alive; BrowserMCP extension authentication is degraded, but CDP\/Playwright remain available/);
  assert.match(hook, /wait "\$chrome_pid"\s+exit \$\?/);
});
