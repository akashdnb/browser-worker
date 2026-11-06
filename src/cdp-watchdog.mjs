import { spawn } from "node:child_process";
import { getCdpResponse } from "./cdp-http.mjs";

const cdpEndpoint = process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const checkIntervalMs = Number.parseInt(process.env.CDP_WATCHDOG_INTERVAL_MS ?? "10000", 10);
const browserStartupTimeoutMs = Number.parseInt(
  process.env.VM_CHROMIUM_STARTUP_TIMEOUT_MS ?? process.env.PLAYWRIGHT_MCP_CDP_TIMEOUT ?? "120000",
  10,
);
const defaultStartupGraceMs = Number.isFinite(browserStartupTimeoutMs)
  ? Math.max(150_000, browserStartupTimeoutMs + 30_000)
  : 150_000;
const startupGraceMs = Number.parseInt(
  process.env.CDP_WATCHDOG_STARTUP_GRACE_MS ?? String(defaultStartupGraceMs),
  10,
);
const failureThreshold = Number.parseInt(process.env.CDP_WATCHDOG_FAILURE_THRESHOLD ?? "3", 10);
const killTimeoutMs = Number.parseInt(process.env.CDP_WATCHDOG_KILL_TIMEOUT_MS ?? "5000", 10);

if (!Number.isFinite(checkIntervalMs) || checkIntervalMs < 1000) throw new Error("CDP_WATCHDOG_INTERVAL_MS must be at least 1000");
if (!Number.isFinite(startupGraceMs) || startupGraceMs < 0) throw new Error("CDP_WATCHDOG_STARTUP_GRACE_MS must be non-negative");
if (!Number.isFinite(failureThreshold) || failureThreshold < 1) throw new Error("CDP_WATCHDOG_FAILURE_THRESHOLD must be at least 1");
if (!Number.isFinite(killTimeoutMs) || killTimeoutMs < 0) throw new Error("CDP_WATCHDOG_KILL_TIMEOUT_MS must be non-negative");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function cdpIsHealthy(endpoint = cdpEndpoint, timeoutMs = 1500) {
  try {
    const response = await getCdpResponse(endpoint, "/json/version", { timeoutMs });
    return response.statusCode === 200;
  } catch {
    return false;
  }
}

/**
 * Stop Chromium and wait for it to exit. A TERM-only kill leaves the wrapper
 * alive forever when Chrome is wedged, preventing vm.js and vm-supervisor from
 * reaching their restart path. Escalate to KILL after a bounded grace period.
 */
export async function killChromium({ graceMs = killTimeoutMs, pollIntervalMs = 250 } = {}) {
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error("graceMs must be non-negative");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 10) throw new Error("pollIntervalMs must be at least 10ms");

  const pattern = "[c]hrom(e|ium).*remote-debugging-port";
  const attempts = Math.max(1, Math.ceil(graceMs / pollIntervalMs));
  const script = `
set +e
pattern='${pattern}'
pkill -TERM -f "$pattern" >/dev/null 2>&1 || true
for ((attempt = 0; attempt < ${attempts}; attempt++)); do
  if ! pgrep -f "$pattern" >/dev/null 2>&1; then exit 0; fi
  sleep ${pollIntervalMs / 1000}
done
echo "Chromium ignored SIGTERM; escalating to SIGKILL" >&2
pkill -KILL -f "$pattern" >/dev/null 2>&1 || true
for ((attempt = 0; attempt < 40; attempt++)); do
  if ! pgrep -f "$pattern" >/dev/null 2>&1; then exit 0; fi
  sleep 0.05
done
echo "Chromium process still matches the CDP process pattern after SIGKILL" >&2
exit 1
`;

  await new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", script], { stdio: ["ignore", "inherit", "inherit"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out while waiting for Chromium termination"));
    }, graceMs + 5000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Chromium termination helper failed (code=${code}, signal=${signal ?? "none"})`));
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
        try {
          await onRestart();
          failures = 0;
          await sleep(1000);
        } catch (error) {
          // A failed recovery attempt must not kill the watchdog. Keep retrying
          // on subsequent probes while the browser remains unavailable.
          failures = Math.max(0, threshold - 1);
          console.error("Chromium recovery attempt failed; watchdog will retry:", error instanceof Error ? error.message : String(error));
        }
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
