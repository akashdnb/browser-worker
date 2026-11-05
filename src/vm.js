import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import WebSocket from "ws";
import { getCdpResponse } from "./cdp-http.mjs";
import { monitorProcessExit } from "./process-monitor.js";

const gatewayUrl = process.env.UTILS_BROWSER_WORKER_URL?.replace(/\/$/, "");
const utilsBaseUrl = gatewayUrl?.replace(/\/browser-worker\/?$/, "");
const token = process.env.UTILS_BROWSER_WORKER_TOKEN;
const workerId = process.env.VM_ID || process.env.VM_WORKER_ID || `github-${process.env.GITHUB_RUN_ID ?? process.pid}`;
const display = process.env.DISPLAY ?? ":99";
const vncPort = Number.parseInt(process.env.VM_VNC_PORT ?? "5900", 10);
const cdpPort = Number.parseInt(process.env.VM_CHROMIUM_DEBUG_PORT ?? "9222", 10);
const chromium = process.env.CHROMIUM_BIN;
const userDataDir = process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? "/tmp/browser-worker-profile";
const workerMode = process.env.WORKER_MODE ?? "browser";
const workerSocketPath = process.env.VM_WORKER_SOCKET_PATH || (process.env.VM_ID ? "/vm-fleet-worker" : "/vm-worker");
const vmLifetimeMinutes = Number.parseInt(process.env.VM_MAX_LIFETIME_MINUTES ?? "345", 10);
if (!Number.isInteger(vmLifetimeMinutes) || vmLifetimeMinutes < 1 || vmLifetimeMinutes > 350) {
  throw new Error("VM_MAX_LIFETIME_MINUTES must be between 1 and 350");
}
// Keep Chromium startup, the Playwright client, and the watchdog on one timeout.
// A restored profile plus extension initialization can legitimately take longer
// than the old 30-second hard-coded probe.
const cdpStartupTimeoutMs = Number.parseInt(
  process.env.VM_CHROMIUM_STARTUP_TIMEOUT_MS ?? process.env.PLAYWRIGHT_MCP_CDP_TIMEOUT ?? "120000",
  10,
);
if (!Number.isFinite(cdpStartupTimeoutMs) || cdpStartupTimeoutMs < 30_000 || cdpStartupTimeoutMs > 300_000) {
  throw new Error("VM_CHROMIUM_STARTUP_TIMEOUT_MS must be between 30000 and 300000");
}

if (!gatewayUrl || !utilsBaseUrl || !token) throw new Error("UTILS_BROWSER_WORKER_URL and UTILS_BROWSER_WORKER_TOKEN are required");
if (workerMode === "browser" && !chromium) throw new Error("CHROMIUM_BIN is required for the interactive VM");

const processes = [];
const vncSockets = new Map();
let stopping = false;
let relayWebSocket = null;

function start(command, env = process.env, { critical = false } = {}) {
  const child = spawn(command[0], command.slice(1), { env, stdio: ["ignore", "inherit", "inherit"] });
  processes.push(child);
  monitorProcessExit(child, command[0], {
    critical,
    isStopping: () => stopping,
    onCriticalExit: () => {
      // Restart the supervisor even when a persistent process exits with code 0.
      // Otherwise Chromium can disappear while the VM/WebSocket relay remains alive.
      process.exitCode = 1;
      void shutdown();
      setTimeout(() => process.exit(1), 1_000);
    },
  });
  return child;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(host, port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error("timeout"));
        }, 1000);
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

async function probeCdp(timeoutMs = cdpStartupTimeoutMs, browserProcess = null) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  const endpoint = `http://127.0.0.1:${cdpPort}`;
  while (Date.now() < deadline) {
    if (browserProcess && (browserProcess.exitCode !== null || browserProcess.signalCode !== null)) {
      lastError = `Chromium process exited before CDP became ready (code=${browserProcess.exitCode}, signal=${browserProcess.signalCode})`;
      console.error(lastError);
      return false;
    }
    try {
      const response = await getCdpResponse(endpoint, "/json/version", { timeoutMs: 1500 });
      if (response.statusCode === 200) {
        console.log(`Chromium CDP ready on 127.0.0.1:${cdpPort}: ${response.body.slice(0, 500)}`);
        return true;
      }
      lastError = `HTTP ${response.statusCode}: ${response.body.slice(0, 300)}`;
    } catch (error) {
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    await sleep(500);
  }
  console.error(`Chromium CDP did not become ready on 127.0.0.1:${cdpPort} after ${timeoutMs}ms: ${lastError}`);
  return false;
}

async function waitForPersistentProfile(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const localStatePath = `${userDataDir}/Local State`;
  const preferencesPath = `${userDataDir}/Default/Preferences`;

  while (Date.now() < deadline) {
    try {
      const [localState, preferences] = await Promise.all([
        stat(localStatePath),
        stat(preferencesPath),
      ]);
      if (localState.isFile() && localState.size > 0 &&
          preferences.isFile() && preferences.size > 0) {
        console.log(`Chromium profile persistence verified at ${userDataDir}`);
        return;
      }
    } catch {
      // Chromium creates profile metadata shortly after CDP becomes available.
    }
    await sleep(500);
  }

  throw new Error(
    `Chromium became available but did not create its persistent profile at ${userDataDir}; refusing to expose a browser session that cannot be archived.`
  );
}

async function cleanProfileLocks() {
  const entries = await readdir(userDataDir).catch(() => []);
  const staleAtomicWriteFiles = entries.filter((name) => name.startsWith(".org.chromium."));
  await Promise.all([
    rm(`${userDataDir}/SingletonLock`, { force: true }),
    rm(`${userDataDir}/SingletonCookie`, { force: true }),
    rm(`${userDataDir}/SingletonSocket`, { force: true }),
    rm(`${userDataDir}/DevToolsActivePort`, { force: true }),
    ...staleAtomicWriteFiles.map((name) => rm(path.join(userDataDir, name), { force: true, recursive: true })),
  ]);
  if (staleAtomicWriteFiles.length) {
    console.log(`Removed ${staleAtomicWriteFiles.length} stale Chromium atomic-write files before startup`);
  }
}

async function waitForDisplaySocket(timeoutMs = 15_000) {
  const displayNumber = display.replace(/^:/, "").split(".")[0];
  const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
  const deadline = Date.now() + timeoutMs;
  let lastError = "socket not created";

  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ path: socketPath });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error("X11 socket connection timed out"));
        }, 1000);
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          socket.destroy();
          reject(error);
        });
      });
      console.log(`X11 display ${display} is ready at ${socketPath}`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(250);
    }
  }
  throw new Error(`X11 display ${display} did not become ready: ${lastError}`);
}

async function killStaleChromium() {
  // Playwright's Linux executable is named "chrome", while older builds may
  // be named "chromium". Match both: killing only "chromium" leaves the real
  // browser orphaned when CHROMIUM_BIN is our shell wrapper.
  const pattern = "'[c]hrom(e|ium).*remote-debugging-port'";
  await runCommand(`pkill -TERM -f ${pattern} || true; sleep 1; pkill -KILL -f ${pattern} || true`, 5);
}

async function startDesktop() {
  if (workerMode === "compute") return;
  const env = { ...process.env, DISPLAY: display };

  // vm-supervisor may have terminated the wrapper process while its real
  // "chrome" child survived. Never reuse that orphan: it can hold the profile
  // lock and its old X11 display may already have been removed.
  await killStaleChromium();
  await cleanProfileLocks();

  start(["Xvfb", display, "-screen", "0", "1440x900x24", "-ac", "+extension", "RANDR"], env, { critical: true });
  await waitForDisplaySocket();
  start(["openbox"], env, { critical: true });

  const chromiumProcess = start([
    chromium,
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--start-maximized",
    "--restore-last-session",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
  ], env, { critical: true });

  // Start VNC only after the display and browser are confirmed. A transient
  // x11vnc startup failure must not kill Chromium while CDP is booting.
  if (!(await probeCdp(cdpStartupTimeoutMs, chromiumProcess))) {
    await killStaleChromium();
    throw new Error(`Chromium CDP did not become ready at 127.0.0.1:${cdpPort}`);
  }

  try {
    await waitForPersistentProfile();
  } catch (error) {
    await killStaleChromium();
    throw error;
  }

  start([
    "x11vnc",
    "-display", display,
    "-localhost",
    "-forever",
    "-shared",
    "-rfbport", String(vncPort),
    "-nopw",
    "-xkb",
    "-noxrecord",
    "-noxfixes",
    "-noxdamage",
    "-always_inject",
    "-input", "KMBC",
  ], env, { critical: true });
  await waitForPort("127.0.0.1", vncPort, 15_000);


}
function clampTimeoutSeconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(86_400, Math.max(1, parsed)) : 60;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function runCommand(command, timeoutSeconds = 60) {
  return await new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { env: { ...process.env, DISPLAY: display }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); if (output.length > 20000) output = output.slice(-20000); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); if (output.length > 20000) output = output.slice(-20000); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ ok: false, error: "command timed out" }); }, clampTimeoutSeconds(timeoutSeconds) * 1000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, returncode: code ?? -1, output }); });
  });
}

let browserMcpBootstrapStarted = false;

async function bootstrapBrowserMcpAfterCdp() {
  if (browserMcpBootstrapStarted) return;
  browserMcpBootstrapStarted = true;
  const bootstrapRunner = process.env.BROWSER_MCP_BOOTSTRAP_RUNNER;
  if (!bootstrapRunner) return;

  console.log("VM relay is authenticated; validating BrowserMCP extension authentication in the background");
  const bootstrap = await runCommand("env -u NODE_OPTIONS node " + shellQuote(bootstrapRunner), 45);
  if (!bootstrap.ok) {
    console.warn("BrowserMCP extension authentication is degraded; keeping Chromium/CDP and the VM relay alive: " + (bootstrap.output || bootstrap.error || "bootstrap failed"));
    return;
  }

  console.log(bootstrap.output?.trim() || "BrowserMCP extension authentication completed");
  if (process.env.BROWSER_MCP_EXTENSION_UPDATED === "1") {
    const finalized = await runCommand(
      "env -u NODE_OPTIONS node --input-type=module -e 'import { finalizeBrowserMcpExtensionUpdate } from \"./src/browser-mcp-bootstrap.mjs\"; await finalizeBrowserMcpExtensionUpdate({ extensionDir: process.env.BROWSER_MCP_EXTENSION_DIR, backupDir: process.env.BROWSER_MCP_EXTENSION_BACKUP_DIR || null });'",
      30,
    );
    if (!finalized.ok) {
      console.warn("BrowserMCP extension update validated but backup cleanup failed: " + (finalized.output || finalized.error || "finalization failed"));
    }
  }
}

async function handleCommand(payload) {
  const action = payload?.action;
  if (action === "status") {
    return {
      ok: true,
      workerId,
      display,
      browser: chromium,
      platform: process.platform,
      userDataDir,
      cdpPort,
      cwd: process.cwd(),
      capabilities: workerMode === "compute" ? ["terminal", "files", "processes", "packages"] : ["desktop", "browser", "terminal", "files", "processes", "screenshot", "packages"],
    };
  }
  if (action === "restore_browser") {
    if (workerMode === "compute") throw new Error("Browser is disabled for this compute-only VM");
    return await runCommand("windows=$(xdotool search --class chromium 2>/dev/null || true); test -n \"$windows\" || { echo 'Chromium window not found' >&2; exit 1; }; for window in $windows; do xdotool windowmap $window 2>/dev/null || true; xdotool windowactivate --sync $window 2>/dev/null || true; xdotool windowraise $window 2>/dev/null || true; xdotool windowsize $window 1440 900 2>/dev/null || true; done", 10);
  }
  if (action === "exec") {
    const command = payload?.command;
    if (typeof command !== "string" || !command.trim() || command.length > 20000) throw new Error("command must be a non-empty string of at most 20000 characters");
    return await runCommand(command, payload?.timeout_seconds);
  }
  if (action === "read_file") {
    const path = payload?.path;
    const maxBytes = Math.min(1_048_576, Math.max(1, Number(payload?.max_bytes ?? 262_144)));
    if (typeof path !== "string" || !path.trim()) throw new Error("path must be a non-empty string");
    const bytes = await readFile(path);
    if (bytes.length > maxBytes) throw new Error(`file is ${bytes.length} bytes; max_bytes is ${maxBytes}`);
    return { ok: true, path, content: bytes.toString("utf8"), bytes: bytes.length };
  }
  if (action === "write_file") {
    const path = payload?.path;
    const content = payload?.content;
    if (typeof path !== "string" || !path.trim()) throw new Error("path must be a non-empty string");
    if (typeof content !== "string") throw new Error("content must be a string");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > 1_048_576) throw new Error("content must be at most 1 MiB");
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    await mkdir(parent, { recursive: true });
    await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
    return { ok: true, path, bytes };
  }
  if (action === "list_files") {
    const path = payload?.path || process.cwd();
    const entries = await readdir(path, { withFileTypes: true });
    const files = [];
    for (const entry of entries.slice(0, 500)) {
      const fullPath = `${path}/${entry.name}`;
      files.push({ name: entry.name, directory: entry.isDirectory(), size: entry.isFile() ? (await stat(fullPath)).size : null });
    }
    return { ok: true, path, files };
  }
  if (action === "search_files") {
    const pattern = payload?.pattern;
    const path = payload?.path || ".";
    const maxResults = Math.min(500, Math.max(1, Number(payload?.max_results ?? 100)));
    if (typeof pattern !== "string" || !pattern.trim()) throw new Error("pattern must be a non-empty string");
    if (pattern.length > 500) throw new Error("pattern must be at most 500 characters");
    const escapedPattern = shellQuote(pattern);
    const escapedPath = shellQuote(path);
    const command = `if command -v rg >/dev/null 2>&1; then rg --line-number --no-heading --hidden --glob '!.git' --glob '!node_modules' --max-count 20 -- ${escapedPattern} ${escapedPath} | head -n ${maxResults}; else grep -RIn --exclude-dir=.git --exclude-dir=node_modules -- ${escapedPattern} ${escapedPath} 2>/dev/null | head -n ${maxResults}; fi`;
    return await runCommand(command, 30);
  }
  if (action === "processes") {
    return await runCommand("ps -eo pid=,ppid=,stat=,etime=,comm=,args= --sort=-etime | head -n 250", 10);
  }
  if (action === "kill_process") {
    const pid = Number(payload?.pid);
    const signal = Number(payload?.signal ?? 15);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer");
    if (!Number.isInteger(signal) || signal < 1 || signal > 64) throw new Error("signal must be between 1 and 64");
    try {
      process.kill(pid, signal);
      return { ok: true, pid, signal };
    } catch (error) {
      return { ok: false, pid, signal, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (action === "screenshot") {
    if (workerMode === "compute") throw new Error("Desktop is disabled for this compute-only VM");
    const path = "/tmp/interactive-vm-screen.png";
    const result = await runCommand(`scrot -o ${shellQuote(path)}`, 15);
    if (!result.ok) return result;
    const image = await readFile(path);
    return { ok: true, mime_type: "image/png", bytes: image.length, base64: image.toString("base64") };
  }
  if (action === "install_package") {
    const packageName = payload?.package;
    const manager = payload?.manager;
    if (typeof packageName !== "string" || !/^[A-Za-z0-9_@./:+-]+$/.test(packageName)) throw new Error("invalid package name");
    if (manager === "apt") return await runCommand(`sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -- ${shellQuote(packageName)}`, 300);
    if (manager === "npm") return await runCommand(`npm install -g ${shellQuote(packageName)}`, 300);
    throw new Error("manager must be apt or npm");
  }
  if (action === "open_url") {
    if (workerMode === "compute") throw new Error("Browser is disabled for this compute-only VM");
    const url = payload?.url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("Only HTTP(S) URLs are allowed");
    start([chromium, "--new-tab", url], { ...process.env, DISPLAY: display });
    return { ok: true, url };
  }
  throw new Error(`unknown action: ${action}`);
}

async function connectVnc(websocket, clientId) {
  await waitForPort("127.0.0.1", vncPort);
  disconnectVnc(clientId);
  const socket = net.createConnection({ host: "127.0.0.1", port: vncPort });
  vncSockets.set(clientId, socket);
  socket.on("data", (chunk) => {
    if (websocket.readyState === WebSocket.OPEN && vncSockets.get(clientId) === socket) {
      // Tag every VNC byte chunk so the relay can deliver it only to the
      // browser client whose independent RFB stream produced it.
      websocket.send(JSON.stringify({
        type: "vm.desktop.frame",
        clientId,
        data: chunk.toString("base64"),
      }));
    }
  });
  socket.on("error", (error) => console.error(`VNC socket error (${clientId}):`, error.message));
  socket.on("close", () => {
    if (vncSockets.get(clientId) === socket) vncSockets.delete(clientId);
  });
}

function disconnectVnc(clientId) {
  const socket = vncSockets.get(clientId);
  vncSockets.delete(clientId);
  if (socket && !socket.destroyed) socket.destroy();
}

function disconnectAllVnc() {
  for (const clientId of vncSockets.keys()) disconnectVnc(clientId);
}

async function connectRelay(uri) {
  return await new Promise((resolve, reject) => {
    const websocket = new WebSocket(uri, {
      maxPayload: 16 * 1024 * 1024,
      handshakeTimeout: 15_000,
    });
    relayWebSocket = websocket;
    let heartbeat;
    let authTimer;
    let connected = false;
    let authenticated = false;
    let fatalError = null;

    websocket.on("open", () => {
      const relay = new URL(uri);
      console.log(`VM relay WebSocket opened at ${relay.origin}${relay.pathname}; authenticating worker ${workerId}`);
      websocket.send(JSON.stringify({
        type: "vm.hello",
        token,
        workerId,
        worker_id: workerId,
        vm_id: workerId,
        capabilities: workerMode === "compute" ? ["terminal", "files", "processes", "packages"] : ["desktop", "browser", "terminal", "files", "processes", "screenshot", "packages"],
      }));
      // A successful TCP/WebSocket upgrade is not proof that the gateway
      // accepted this worker. Wait for the explicit auth acknowledgement
      // before announcing readiness or sending heartbeats.
      authTimer = setTimeout(() => {
        fatalError = new Error("Timed out waiting for vm.auth.ok from utils after vm.hello");
        console.error(fatalError.message);
        websocket.terminate();
      }, 15_000);
    });

    websocket.on("message", async (raw, isBinary) => {
      if (isBinary) return;
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === "vm.auth.ok") {
        if (authTimer) clearTimeout(authTimer);
        authenticated = true;
        connected = true;
        console.log(`Interactive VM authenticated and connected to utils as ${workerId}`);
        if (workerMode === "browser") {
          console.log(`Shared Chromium is ready on CDP 127.0.0.1:${cdpPort} using ${userDataDir}`);
          void bootstrapBrowserMcpAfterCdp();
        }
        heartbeat = setInterval(() => {
          if (websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({ type: "vm.heartbeat", workerId, ts: Date.now() }));
          }
        }, 15_000);
        return;
      }
      if (message.type === "vm.auth.failed") {
        fatalError = new Error("Interactive VM authentication failed: utils rejected vm.hello");
        console.error(fatalError.message);
        websocket.close(1008, "worker authentication failed");
        return;
      }
      if (!authenticated) return;
      if (message.type === "vm.desktop.start") {
        try {
          await connectVnc(websocket, String(message.clientId));
          console.log(`Interactive VM VNC bridge attached for ${message.clientId}`);
        } catch (error) {
          console.error(`Failed to connect VNC bridge for ${message.clientId}:`, error instanceof Error ? error.message : error);
        }
        return;
      }
      if (message.type === "vm.desktop.input") {
        const clientId = String(message.clientId ?? "");
        const socket = vncSockets.get(clientId);
        if (!socket || socket.destroyed || typeof message.data !== "string") return;
        try { socket.write(Buffer.from(message.data, "base64")); } catch (error) {
          console.error(`Failed to forward VNC input for ${clientId}:`, error instanceof Error ? error.message : error);
        }
        return;
      }
      if (message.type === "vm.desktop.stop") {
        disconnectVnc(String(message.clientId ?? ""));
        return;
      }
      if (message.type === "vm.shutdown") {
        void shutdown();
        return;
      }
      if (message.type === "vm.task.execute") {
        try {
          const result = await handleCommand({ action: "exec", command: message.command, timeout_seconds: message.timeout_seconds });
          if (websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
              type: "vm.task.result",
              request_id: message.request_id,
              result: { returncode: result.returncode ?? (result.ok ? 0 : 1), stdout: result.stdout ?? result.output ?? "", stderr: result.stderr ?? result.error ?? "" },
            }));
          }
        } catch (error) {
          if (websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({ type: "vm.task.error", request_id: message.request_id, error: error instanceof Error ? error.message : String(error) }));
          }
        }
        return;
      }
      if (message.type === "vm.file.write") {
        try {
          const data = Buffer.from(String(message.content_base64 || ""), "base64");
          if (data.length > 1_048_576) throw new Error("file payload exceeds 1 MB");
          await mkdir(path.dirname(message.path), { recursive: true });
          await writeFile(message.path, data, { mode: 0o600 });
          websocket.send(JSON.stringify({ type: "vm.file.result", request_id: message.request_id, bytes_written: data.length }));
        } catch (error) {
          websocket.send(JSON.stringify({ type: "vm.file.error", request_id: message.request_id, error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }
      if (message.type === "vm.file.read") {
        try {
          const data = await readFile(message.path);
          if (data.length > 1_048_576) throw new Error("file payload exceeds 1 MB");
          websocket.send(JSON.stringify({ type: "vm.file.result", request_id: message.request_id, content_base64: data.toString("base64"), bytes_read: data.length }));
        } catch (error) {
          websocket.send(JSON.stringify({ type: "vm.file.error", request_id: message.request_id, error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }
      if (message.type === "vm.shutdown") {
        void shutdown();
        websocket.close(1000, "VM shutdown requested");
        return;
      }
      if (message.type === "vm.command") {
        try {
          const result = await handleCommand(message.payload ?? {});
          if (websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({ type: "vm.response", requestId: message.requestId, ...result }));
          }
        } catch (error) {
          if (websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({ type: "vm.response", requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }));
          }
        }
      }
    });

    websocket.on("error", (error) => console.error("Interactive VM WebSocket error:", error.message));
    websocket.on("close", (code, reason) => {
      if (heartbeat) clearInterval(heartbeat);
      if (authTimer) clearTimeout(authTimer);
      disconnectAllVnc();
      if (fatalError) {
        reject(fatalError);
        return;
      }
      console.warn(`Interactive VM relay disconnected (code=${code}, reason=${reason.toString() || "none"})`);
      resolve({ connected });
    });
  });
}

async function main() {
  if (workerMode === "browser") {
    await startDesktop();
    await waitForPort("127.0.0.1", vncPort);
  }

  const uri = `${utilsBaseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}${workerSocketPath}`;
  console.log(`Starting interactive VM relay at ${uri} for worker ${workerId}`);
  let backoffMs = 2_000;

  while (!stopping) {
    const connection = await connectRelay(uri);
    if (stopping) break;
    if (connection.connected) backoffMs = 2_000;
    console.warn(`Interactive VM relay will reconnect in ${backoffMs / 1000}s without restarting Chromium`);
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function runShutdownScripts() {
  const specPath = process.env.VM_SPEC_PATH;
  if (!specPath) return;
  let scripts = [];
  try {
    const spec = JSON.parse(await readFile(specPath, "utf8"));
    scripts = spec.startup?.shutdown_scripts ?? [];
  } catch (error) {
    console.warn("Could not load VM shutdown scripts:", error instanceof Error ? error.message : String(error));
    return;
  }
  const deadline = Date.now() + 120_000;
  for (const script of scripts) {
    const remaining = Math.floor((deadline - Date.now()) / 1000);
    if (remaining < 1) {
      console.warn("VM shutdown script time budget exhausted");
      break;
    }
    const result = await runCommand(script, Math.min(30, remaining));
    if (!result.ok) {
      console.warn("VM shutdown script failed:", result.error || result.output || result.returncode);
    }
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  await runShutdownScripts();
  disconnectAllVnc();
  if (relayWebSocket && relayWebSocket.readyState === WebSocket.OPEN) {
    try { relayWebSocket.close(1000, "VM lifecycle ended"); } catch {}
  }

  // Ask Chromium to exit first and give it time to flush its session/tab files.
  // Killing its parent VM relay must not race Chromium's clean profile shutdown.
  const chromiumChildren = processes.filter((child) =>
    (child.spawnargs?.[0] ?? "") === chromium
  );
  const remainingChildren = processes.filter((child) =>
    (child.spawnargs?.[0] ?? "") !== chromium
  );

  for (const child of chromiumChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  for (const child of chromiumChildren) {
    if (!(await waitForChildExit(child, 15_000))) {
      console.warn("Chromium did not exit gracefully within 15s; forcing termination");
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForChildExit(child, 2_000);
    }
  }

  for (const child of [...remainingChildren].reverse()) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(remainingChildren.map((child) => waitForChildExit(child, 2_000)));
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

const lifetimeTimer = setTimeout(() => {
  console.log(`VM lifetime limit reached after ${vmLifetimeMinutes} minutes; closing the runner worker.`);
  void shutdown();
}, vmLifetimeMinutes * 60_000);
lifetimeTimer.unref();
await main();
clearTimeout(lifetimeTimer);
await shutdown();
