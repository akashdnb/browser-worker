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
  assert.match(workflow, /group: browser-worker-guard-\$\{\{ github\.ref \}\}-\$\{\{ inputs\.vm_id \|\| 'legacy' \}\}-v6/);
});

test("stale queued legacy runs do not block recovery", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /Ignoring stale queued legacy Browser Worker run/);
  assert.match(workflow, /age_seconds.*-gt 600/);
  assert.doesNotMatch(workflow, /gh run cancel "\$candidate"/);
});

test("legacy guard identifies fleet runs from run names without per-run API calls", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /\[\.id,\.created_at,\.display_title\]/);
  assert.match(workflow, /"VM "\*\) continue/);
  assert.doesNotMatch(workflow, /gh run view "\$candidate"/);
});

test("each recovery run can replace a stuck prior guard", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: \$\{\{ github\.workflow \}\}-\$\{\{ inputs\.vm_id \|\| 'legacy-browser-session' \}\}-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("push handoff can replace an orphaned legacy run without waiting on its concurrency lock", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /Push handoff uses the legacy browser job concurrency group/);
  assert.match(workflow, /should_start=true/);
  assert.match(workflow, /format\('utils-vm-legacy-browser-session-\{0\}', github\.run_id\)/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ inputs\.vm_id != '' \}\}/);
  assert.match(workflow, /gh run cancel "\$run_id"/);
  assert.match(workflow, /timeout-minutes: 2/);
  assert.ok(workflow.indexOf("Stop older worker runs after a push deployment") < workflow.indexOf("Set up Node.js"));
});

test("legacy browser startup cleans stale Chromium temp files and waits for the full startup window", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  const vm = await readFile(new URL("../src/vm.js", import.meta.url), "utf8");
  assert.match(workflow, /for attempt in \\$\\(seq 1 600\\)/);
  assert.match(workflow, /find "\\$stage\\/browser-worker-profile" -maxdepth 1 -type f -name '\\.org\\.chromium\\.\\*' -delete/);
  assert.match(vm, /name\\.startsWith\\("\\.org\\.chromium\\."\\)/);
});

test("legacy guard uses the GitHub REST run title and path fields", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /gh api "repos\/\$REPO\/actions\/runs\?status=\$run_state&per_page=100"/);
  assert.match(workflow, /\.path == "\.github\/workflows\/browser-worker\.yml"/);
  assert.match(workflow, /\.display_title/);
});
