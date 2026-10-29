import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("VM supervisor preloads the BrowserMCP extension before starting the relay", async () => {
  const supervisor = await readFile(new URL("../src/vm-supervisor.sh", import.meta.url), "utf8");
  assert.match(supervisor, /while true/);
  assert.match(supervisor, /node --import \.\/src\/vm-heartbeat-hook\.mjs src\/vm\.js/);
  assert.match(supervisor, /backoff/);
  assert.match(supervisor, /BrowserMCP VM extension bootstrap runs as a Node preload/);
});
