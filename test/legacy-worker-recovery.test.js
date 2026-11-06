import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("legacy startup verifies its Utils token before launching the browser", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  const preflight = workflow.indexOf("Verify authenticated legacy worker endpoint");
  const browserStart = workflow.indexOf("Run browser worker and interactive desktop");
  assert.ok(preflight >= 0 && preflight < browserStart);
  const section = workflow.slice(preflight, browserStart);
  assert.match(section, /WORKER_TOKEN: \$\{\{ secrets\.UTILS_BROWSER_WORKER_TOKEN \}\}/);
  assert.match(section, /\/vm\/worker-health/);
  assert.match(section, /Authorization: Bearer \$WORKER_TOKEN/);
  assert.match(section, /health_code.*401/);
  assert.match(section, /health_code.*200/);
});

test("legacy browser worker has a frequent recovery trigger", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /schedule:\s*\n\s+- cron: "\*\/10 \* \* \* \*"/);
});

test("legacy recovery guard trusts authenticated Utils liveness, not stale Actions run state", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /\/vm\/worker-health/);
  assert.match(workflow, /Authorization: Bearer \$WORKER_TOKEN/);
  assert.match(workflow, /worker_connected" = "true"/);
  assert.match(workflow, /Utils reports no connected legacy worker/);
  assert.match(workflow, /age_seconds.*-lt 1800/);
  assert.match(workflow, /actions\/runs\/\$active_run_id\/cancel/);
  assert.match(workflow, /source_run_id=\$active_run_id/);
  assert.match(workflow, /\.run_started_at/);
});

test("fleet VM guards do not serialize behind the legacy worker guard", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: browser-worker-guard-\$\{\{ github\.ref \}\}-\$\{\{ inputs\.vm_id \|\| 'legacy' \}\}-v7/);
});

test("stale queued legacy runs do not block recovery", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /Cancelling stale queued legacy Browser Worker run/);
  assert.match(workflow, /age_seconds.*-gt 600/);
  assert.match(workflow, /actions\/runs\/\$candidate\/cancel/);
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
  assert.match(workflow, /timeout-minutes: 10/);
  assert.ok(workflow.indexOf("Stop older worker runs after a push deployment") < workflow.indexOf("Set up Node.js"));
});

test("legacy browser startup cleans stale Chromium temp files and waits for the full startup window", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  const vm = await readFile(new URL("../src/vm.js", import.meta.url), "utf8");
  assert.ok(workflow.includes("for attempt in $(seq 1 600); do"));
  assert.ok(workflow.includes("find \"$stage/browser-worker-profile\" -maxdepth 1 -type f -name '.org.chromium.*' -delete"));
  assert.ok(vm.includes('name.startsWith(".org.chromium.")'));
});

test("legacy guard uses the GitHub REST run title and path fields", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /gh api "repos\/\$REPO\/actions\/runs\?status=\$run_state&per_page=100"/);
  assert.match(workflow, /\.path == "\.github\/workflows\/browser-worker\.yml"/);
  assert.match(workflow, /\.display_title/);
});


test("scheduled recovery restores the cancelled worker's final profile", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /source_run_id: \$\{\{ steps\.check\.outputs\.source_run_id \}\}/);
  assert.match(workflow, /inputs\.source_run_id \|\| needs\.guard\.outputs\.source_run_id/);
  assert.match(workflow, /timeout-minutes: 10/);
});

test("push handoff bypasses health probing so a deployment can recover a dead worker", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  const push = workflow.indexOf('if [ "$EVENT_NAME" = "push" ]; then');
  const probe = workflow.indexOf("/vm/worker-health");
  assert.ok(push >= 0 && probe > push);
});

test("stale queued-run notices do not become false-positive queued run IDs", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /Cancelling stale queued legacy Browser Worker run \$candidate[^\n]*>&2/);
});

test("legacy stale-run age is measured from runner start time", async () => {
  const workflow = await readFile(new URL("../.github/workflows/browser-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /date -d "\$active_started_at"/);
  assert.doesNotMatch(workflow, /date -d "\$active_created_at"/);
});
