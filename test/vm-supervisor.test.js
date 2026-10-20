import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("VM supervisor keeps BrowserMCP extension bootstrap disabled", async () => {
  const supervisor = await readFile(new URL("../src/vm-supervisor.sh", import.meta.url), "utf8");
  assert.match(supervisor, /BrowserMCP VM extension bootstrap is intentionally disabled/);
  assert.match(supervisor, /existing Playwright\/CDP path/);
  assert.match(supervisor, /node src\/vm\.js/);
  assert.doesNotMatch(supervisor, /BROWSER_MCP_REAL_CHROMIUM/);
  assert.doesNotMatch(supervisor, /browser-mcp-chromium-wrapper\.mjs/);
});
