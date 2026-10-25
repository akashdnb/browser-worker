import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("VM startup prepares the BrowserMCP extension before Chrome", async () => {
  const hook = await readFile(new URL("../src/vm-heartbeat-hook.mjs", import.meta.url), "utf8");
  assert.match(hook, /prepareBrowserMcpExtension/);
  assert.match(hook, /--load-extension=\$extension_dir/);
  assert.match(hook, /--disable-extensions-except=\$extension_dir/);
  assert.match(hook, /rollbackBrowserMcpExtensionUpdate/);
  assert.match(hook, /finalizeBrowserMcpExtensionUpdate/);
});

test("BrowserMCP bootstrap retries failures and validates the authoritative extension", async () => {
  const bootstrap = await readFile(new URL("../src/browser-mcp-bootstrap.mjs", import.meta.url), "utf8");
  assert.match(bootstrap, /grant_type: "urn:render:browser-worker"/);
  assert.match(bootstrap, /extension_version/);
  assert.match(bootstrap, /already satisfies authoritative version/);
  assert.match(bootstrap, /no downgrade/);
  assert.match(bootstrap, /manifest\.background\?\.service_worker/);
  assert.match(bootstrap, /\.update-pending/);
});
