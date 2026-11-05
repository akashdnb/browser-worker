import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("legacy browser worker has a frequent recovery trigger", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /schedule:\s*\n\s+- cron: "\*\/10 \* \* \* \*"/);
});

test("legacy recovery guard skips cleanly when a worker is already active", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /Legacy Browser Worker is already active or queued/);
  assert.doesNotMatch(workflow, /::error::Refusing to start while another Browser Worker run is active/);
});
