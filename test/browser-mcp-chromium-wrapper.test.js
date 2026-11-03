import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("VM startup stages the BrowserMCP extension without bootstrapping before CDP", async () => {
  const hook = await readFile(new URL("../src/vm-heartbeat-hook.mjs", import.meta.url), "utf8");
  const vm = await readFile(new URL("../src/vm.js", import.meta.url), "utf8");
  assert.match(hook, /prepareBrowserMcpExtension/);
  assert.match(hook, /--load-extension=\$extension_dir/);
  assert.match(hook, /--disable-extensions-except=\$extension_dir/);
  assert.match(hook, /BROWSER_MCP_EXTENSION_REQUIRED !== "false"/);
  assert.match(hook, /BROWSER_MCP_EXTENSION_BACKUP_DIR/);
  assert.match(hook, /BROWSER_MCP_EXTENSION_UPDATED/);
  assert.doesNotMatch(hook, /run_bootstrap\(\)/);
  assert.match(vm, /finalizeBrowserMcpExtensionUpdate/);
  assert.match(vm, /bootstrapBrowserMcpAfterCdp/);
});

test("BrowserMCP bootstrap validates the authoritative extension", async () => {
  const bootstrap = await readFile(new URL("../src/browser-mcp-bootstrap.mjs", import.meta.url), "utf8");
  assert.match(bootstrap, /grant_type: "urn:render:browser-worker"/);
  assert.match(bootstrap, /extension_version/);
  assert.match(bootstrap, /already satisfies authoritative version/);
  assert.match(bootstrap, /no downgrade/);
  assert.match(bootstrap, /manifest\.background\?\.service_worker/);
  assert.match(bootstrap, /\.update-pending/);
});
