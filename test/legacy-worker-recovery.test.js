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

test("fleet VM guards do not serialize behind the legacy worker guard", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: browser-worker-guard-\$\{\{ github\.ref \}\}-\$\{\{ inputs\.vm_id \|\| 'legacy' \}\}-v3/);
});

test("stale queued legacy runs do not block recovery", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /Ignoring stale queued legacy Browser Worker run/);
  assert.match(workflow, /age_seconds.*-gt 600/);
  assert.doesNotMatch(workflow, /gh run cancel "\$candidate"/);
});

test("legacy guard identifies fleet runs from run names without per-run API calls", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /\[\.databaseId,\.createdAt,\.name\]/);
  assert.match(workflow, /"VM "\*\) continue/);
  assert.doesNotMatch(workflow, /gh run view "\$candidate"/);
});

test("each recovery run can replace a stuck prior guard", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: \$\{\{ github\.workflow \}\}-\$\{\{ inputs\.vm_id \|\| 'legacy-browser-session' \}\}-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("push handoff cancels active legacy runs without waiting on gh run cancel", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /gh api --method POST "repos\/\$REPO\/actions\/runs\/\$stale_run_id\/cancel"/);
  assert.doesNotMatch(workflow, /gh run cancel "\$stale_run_id"/);
  assert.match(workflow, /timeout-minutes: 2/);
});
