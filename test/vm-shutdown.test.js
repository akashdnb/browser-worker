import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("VM shutdown waits for Chromium to flush session files before stopping desktop", async () => {
  const source = await readFile(new URL("../src/vm.js", import.meta.url), "utf8");
  const shutdown = source.slice(source.indexOf("async function shutdown()"));
  const chromiumStop = shutdown.indexOf("child.kill(\"SIGTERM\")");
  const waitForExit = shutdown.indexOf("waitForChildExit(child, 15_000)");
  const forcedStop = shutdown.indexOf("child.kill(\"SIGKILL\")");
  const desktopStop = shutdown.indexOf("for (const child of [...remainingChildren].reverse())");

  assert.notEqual(chromiumStop, -1);
  assert.notEqual(waitForExit, -1);
  assert.notEqual(forcedStop, -1);
  assert.notEqual(desktopStop, -1);
  assert.ok(chromiumStop < waitForExit);
  assert.ok(waitForExit < forcedStop);
  assert.ok(forcedStop < desktopStop);
  assert.match(source, /"--restore-last-session"/);
});

test("VM profile checkpoint uses a stable workspace profile path", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /PLAYWRIGHT_MCP_USER_DATA_DIR: .*github\.workspace.*browser-worker-state\/live-profile/);
  assert.match(workflow, /BROWSER_WORKER_CHECKPOINT_SECONDS: "60"/);
});


test("managed VM workers never receive a GitHub repository write token", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
  const publisher = await readFile(new URL("../.github/workflows/publish-vm-profile.yml", import.meta.url), "utf8");

  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ !inputs\.vm_id && github\.token \|\| '' \}\}/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ !inputs\.vm_id && github\.token \|\| '' \}\}/);
  assert.match(worker, /if \(!process\.env\.VM_ID && \(!githubToken \|\| !githubRepository \|\| !githubRunId\)\)/);
  assert.match(publisher, /workflow_run:/);
  assert.match(publisher, /contents: write/);
});

test("fleet profile encryption key is obtained through the OIDC bootstrap response", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /browser_profile_encryption_key/);
  assert.match(workflow, /BROWSER_WORKER_PROFILE_ENCRYPTION_KEY=\$profile_key/);
  assert.match(workflow, /vm-profile-\$\{\{ inputs\.vm_id \}\}/);
});
