import { spawn } from "node:child_process";

const cdpEndpoint = process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const checkIntervalMs = Number.parseInt(process.env.CDP_WATCHDOG_INTERVAL_MS ?? "10000", 10);
const startupGraceMs = Number.parseInt(process.env.CDP_WATCHDOG_STARTUP_GRACE_MS ?? "90000", 10);
const failureThreshold = Number.parseInt(process.env.CDP_WATCHDOG_FAILURE_THRESHOLD ?? "3", 10);
const killTimeoutMs = Number.parseInt(process.env.CDP_WATCHDOG_KILL_TIMEOUT_MS ?? "5000", 10);

if (!Number.isFinite(checkIntervalMs) || checkIntervalMs < 1000) throw new Error("CDP_WATCHDOG_INTERVAL_MS must be at least 1000");
if (!Number.isFinite(startupGraceMs) || startupGraceMs < 0) throw new Error("CDP_WATCHDOG_STARTUP_GRACE_MS must be non-negative");
if (!Number.isFinite(failureThreshold) || failureThreshold < 1) throw new Error("CDP_WATCHDOG_FAILURE_THRESHOLD must be at least 1");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function cdpIsHealthy(endpoint = cdpEndpoint, timeoutMs = 1500) {
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    await response.text();
    return true;
  } catch {
    return false;
  }
}

function killChromium() {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", "pkill -TERM -f '[c]hromium.*remote-debugging-port' || true"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, killTimeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function runCdpWatchdog({
  endpoint = cdpEndpoint,
  intervalMs = checkIntervalMs,
  startupGraceMs: graceMs = startupGraceMs,
  threshold = failureThreshold,
  onRestart = killChromium,
  shouldStop = () => false,
} = {}) {
  if (graceMs > 0) await sleep(graceMs);

  let failures = 0;
  while (!shouldStop()) {
    if (await cdpIsHealthy(endpoint)) {
      if (failures > 0) console.log("Chromium CDP recovered");
      failures = 0;
    } else {
      failures += 1;
      console.warn(`Chromium CDP health check failed (${failures}/${threshold}) at ${endpoint}`);
      if (failures >= threshold) {
        console.error("Chromium CDP is unavailable; terminating Chromium so vm-supervisor can restart the browser");
        await onRestart();
        failures = 0;
        await sleep(1000);
      }
    }
    await sleep(intervalMs);
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  runCdpWatchdog().catch((error) => {
    console.error("CDP watchdog failed:", error);
    process.exitCode = 1;
  });
}
