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

test("BrowserMCP bootstrap retries failures and caches by extension version", async () => {
  const wrapper = await readFile(new URL("../src/browser-mcp-chromium-wrapper.mjs", import.meta.url), "utf8");
  assert.match(wrapper, /grant_type: "urn:render:browser-worker"/);
  assert.match(wrapper, /extension_version/);
  assert.match(wrapper, /already installed; reusing cached files/);
  assert.match(wrapper, /extension service worker did not start/);
  assert.match(wrapper, /chrome\.storage\.local\.set/);
});
