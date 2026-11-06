import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("browser workers install and use Playwright-managed Chromium", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");

  assert.match(workflow, /node_modules\/playwright-core\/cli\.js/);
  assert.match(workflow, /install --with-deps chromium/);
  assert.match(workflow, /PLAYWRIGHT_CHROMIUM_BIN=/);
  assert.match(workflow, /chromium\.executablePath\(\)/);
  assert.match(workflow, /Using pinned Playwright Chromium/);
  assert.doesNotMatch(workflow, /command -v chromium/);
  assert.doesNotMatch(workflow, /command -v google-chrome/);
});

test("browser worker workflow verifies CDP before starting the VM", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  const smokeTest = workflow.slice(
    workflow.indexOf("- name: Verify Chromium DevTools startup"),
    workflow.indexOf("- name: Run browser worker and interactive desktop"),
  );

  assert.ok(smokeTest.length > 0, "Chromium CDP smoke test step must exist");
  assert.match(smokeTest, /--remote-debugging-port=/);
  assert.match(smokeTest, /\/json\/version/);
  assert.match(smokeTest, /Chromium CDP smoke test passed/);
  assert.match(smokeTest, /Playwright Chromium failed to open its DevTools endpoint/);
});
