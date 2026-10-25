import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { compareExtensionVersions, prepareBrowserMcpExtension, rollbackBrowserMcpExtensionUpdate } from "../src/browser-mcp-bootstrap.mjs";

async function makeBundle(version) {
  const root = await mkdtemp(join(tmpdir(), "browser-mcp-bundle-"));
  const extension = join(root, "browser_extension");
  await mkdir(extension, { recursive: true });
  await writeFile(join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Browser MCP", version, background: { service_worker: "background.js" } }));
  await writeFile(join(extension, "background.js"), "self.addEventListener('install', () => {});");
  const archive = `${root}.tar.gz`;
  assert.equal(spawnSync("tar", ["-czf", archive, "-C", root, "browser_extension"]).status, 0);
  return { root, archive };
}

function mockFetch(version, archive) {
  return async () => new Response(JSON.stringify({
    access_token: "test-token",
    extension_version: version,
    extension_bundle_base64: (await readFile(archive)).toString("base64"),
    extension_bundle_format: "tar.gz",
  }), { status: 200 });
}

test("extension versions compare numerically", () => {
  assert.equal(compareExtensionVersions("0.5.1", "0.5.1"), 0);
  assert.equal(compareExtensionVersions("0.5.2", "0.5.1"), 1);
  assert.equal(compareExtensionVersions("0.5.1", "0.5.2"), -1);
  assert.equal(compareExtensionVersions("1.0", "1.0.0"), 0);
});

test("same version is reused and newer installed versions are not downgraded", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-mcp-extension-"));
  const extensionDir = join(root, "BrowserMCPExtension");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(join(extensionDir, "manifest.json"), JSON.stringify({ version: "0.5.2" }));
  const bundle = await makeBundle("0.5.1");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch("0.5.1", bundle.archive);
  try {
    const result = await prepareBrowserMcpExtension({ baseUrl: "https://utils.example", workerToken: "worker", workerId: "test", extensionDir });
    assert.equal(result.updated, false);
    assert.equal(result.extensionVersion, "0.5.2");
    assert.equal(JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8")).version, "0.5.2");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
    await rm(bundle.root, { recursive: true, force: true });
    await rm(bundle.archive, { force: true });
  }
});

test("newer version is staged with a rollback backup and pending marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-mcp-extension-"));
  const extensionDir = join(root, "BrowserMCPExtension");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(join(extensionDir, "manifest.json"), JSON.stringify({ version: "0.5.1" }));
  const bundle = await makeBundle("0.5.2");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch("0.5.2", bundle.archive);
  try {
    const result = await prepareBrowserMcpExtension({ baseUrl: "https://utils.example", workerToken: "worker", workerId: "test", extensionDir });
    assert.equal(result.updated, true);
    assert.equal(result.previousVersion, "0.5.1");
    assert.equal(JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8")).version, "0.5.2");
    assert.equal(JSON.parse(await readFile(join(result.backupDir, "manifest.json"), "utf8")).version, "0.5.1");
    assert.match(await readFile(join(extensionDir, ".update-pending"), "utf8"), /0.5.1/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
    await rm(bundle.root, { recursive: true, force: true });
    await rm(bundle.archive, { force: true });
  }
});

test("rollback restores the last known-good version", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-mcp-extension-"));
  const extensionDir = join(root, "BrowserMCPExtension");
  const backupDir = `${extensionDir}.previous`;
  await mkdir(extensionDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });
  await writeFile(join(extensionDir, "manifest.json"), JSON.stringify({ version: "0.5.2" }));
  await writeFile(join(extensionDir, ".update-pending"), JSON.stringify({ previousVersion: "0.5.1", targetVersion: "0.5.2" }));
  await writeFile(join(backupDir, "manifest.json"), JSON.stringify({ version: "0.5.1" }));
  try {
    await rollbackBrowserMcpExtensionUpdate({ extensionDir, backupDir });
    assert.equal(JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8")).version, "0.5.1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
