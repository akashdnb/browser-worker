import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("VM supervisor keeps the relay restart loop independent of BrowserMCP bootstrap", async () => {
  const supervisor = await readFile(new URL("../src/vm-supervisor.sh", import.meta.url), "utf8");
  assert.match(supervisor, /while true/);
  assert.match(supervisor, /node src\/vm\.js/);
  assert.match(supervisor, /backoff/);
  assert.doesNotMatch(supervisor, /BROWSER_MCP_REAL_CHROMIUM/);
  assert.doesNotMatch(supervisor, /browser-mcp-chromium-wrapper\.mjs/);
});
