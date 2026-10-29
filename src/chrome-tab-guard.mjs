const cdpEndpoint = process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const maxTabs = Number.parseInt(process.env.CHROME_MAX_TABS ?? "15", 10);
const intervalMs = Number.parseInt(process.env.CHROME_TAB_GUARD_INTERVAL_MS ?? "5000", 10);
const startupGraceMs = Number.parseInt(process.env.CHROME_TAB_GUARD_STARTUP_GRACE_MS ?? "30000", 10);

if (!Number.isInteger(maxTabs) || maxTabs < 1 || maxTabs > 100) {
  throw new Error("CHROME_MAX_TABS must be between 1 and 100");
}
if (!Number.isInteger(intervalMs) || intervalMs < 1000) {
  throw new Error("CHROME_TAB_GUARD_INTERVAL_MS must be at least 1000ms");
}
if (!Number.isInteger(startupGraceMs) || startupGraceMs < 0) {
  throw new Error("CHROME_TAB_GUARD_STARTUP_GRACE_MS must be non-negative");
}

const endpoint = cdpEndpoint.replace(/\/$/, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listTabs() {
  const response = await fetch(`${endpoint}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`CDP /json/list returned HTTP ${response.status}`);
  const targets = await response.json();
  return Array.isArray(targets) ? targets.filter((target) => target?.type === "page" && target?.id) : [];
}

async function closeTab(target) {
  const response = await fetch(`${endpoint}/json/close/${encodeURIComponent(target.id)}`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) {
    throw new Error(`failed to close tab ${target.id}: HTTP ${response.status}`);
  }
}

async function enforceLimit() {
  const tabs = await listTabs();
  if (tabs.length <= maxTabs) return;

  // CDP normally returns targets in creation order. Keep the first maxTabs
  // targets and close the newest excess tabs. Closing is best-effort per tab;
  // one bad target must not stop the guard from enforcing the global limit.
  const excess = tabs.slice(maxTabs);
  let closed = 0;
  for (const tab of excess) {
    try {
      await closeTab(tab);
      closed += 1;
    } catch (error) {
      console.warn(`Chrome tab guard could not close ${tab.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.warn(`Chrome tab guard enforced max=${maxTabs}: observed=${tabs.length}, excess=${excess.length}, closed=${closed}`);
}

async function run() {
  if (startupGraceMs > 0) await sleep(startupGraceMs);
  console.log(`Chrome tab guard started: max=${maxTabs}, interval=${intervalMs}ms, endpoint=${endpoint}`);

  while (true) {
    try {
      await enforceLimit();
    } catch (error) {
      // CDP may be temporarily unavailable during Chromium restart. Keep the
      // guard alive so it automatically resumes once the browser recovers.
      console.warn(`Chrome tab guard health check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(intervalMs);
  }
}

run().catch((error) => {
  console.error("Chrome tab guard failed:", error);
  process.exitCode = 1;
});
