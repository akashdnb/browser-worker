import { spawn } from "node:child_process";
import net from "node:net";
import WebSocket from "ws";

const utilsUrl = process.env.UTILS_BROWSER_WORKER_URL?.replace(/\/$/, "");
const token = process.env.UTILS_BROWSER_WORKER_TOKEN;
const workerId = process.env.VM_WORKER_ID ?? `github-${process.env.GITHUB_RUN_ID ?? process.pid}`;
const display = process.env.DISPLAY ?? ":99";
const vncPort = Number.parseInt(process.env.VM_VNC_PORT ?? "5900", 10);
const chromium = process.env.CHROMIUM_BIN;

if (!utilsUrl || !token) throw new Error("UTILS_BROWSER_WORKER_URL and UTILS_BROWSER_WORKER_TOKEN are required");
if (!chromium) throw new Error("CHROMIUM_BIN is required for the interactive VM");

const processes = [];
let stopping = false;

function start(command, env = process.env) {
  const child = spawn(command[0], command.slice(1), { env, stdio: ["ignore", "inherit", "inherit"] });
  processes.push(child);
  child.on("exit", (code, signal) => {
    if (!stopping && code !== 0) console.error(`VM process exited: ${command[0]} code=${code} signal=${signal}`);
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

function startDesktop() {
  const env = { ...process.env, DISPLAY: display };
  start(["Xvfb", display, "-screen", "0", "1440x900x24", "-ac", "+extension", "RANDR"], env);
  start(["openbox"], env);
  start([
    chromium,
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--start-maximized",
    "--user-data-dir=/tmp/interactive-vm-chromium",
    "about:blank",
  ], env);
  start(["x11vnc", "-display", display, "-localhost", "-forever", "-shared", "-rfbport", String(vncPort), "-nopw"], env);
}

async function handleCommand(payload) {
  const action = payload?.action;
  if (action === "status") {
    return { ok: true, workerId, display, browser: chromium, platform: process.platform };
  }
  if (action === "exec") {
    const command = payload?.command;
    if (typeof command !== "string" || !command.trim() || command.length > 4000) throw new Error("command must be a non-empty string of at most 4000 characters");
    return await new Promise((resolve) => {
      const child = spawn("bash", ["-lc", command], { env: { ...process.env, DISPLAY: display }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk.toString(); if (output.length > 20000) output = output.slice(-20000); });
      child.stderr.on("data", (chunk) => { output += chunk.toString(); if (output.length > 20000) output = output.slice(-20000); });
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ ok: false, error: "command timed out" }); }, 60_000);
      child.on("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, returncode: code ?? -1, output }); });
    });
  }
  if (action === "list_files") {
    const { readdir, stat } = await import("node:fs/promises");
    const path = payload?.path || process.cwd();
    const entries = await readdir(path, { withFileTypes: true });
    const files = [];
    for (const entry of entries.slice(0, 500)) {
      const fullPath = `${path}/${entry.name}`;
      files.push({ name: entry.name, directory: entry.isDirectory(), size: entry.isFile() ? (await stat(fullPath)).size : null });
    }
    return { ok: true, path, files };
  }
  if (action === "open_url") {
    const url = payload?.url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("Only HTTP(S) URLs are allowed");
    start([chromium, "--new-tab", url], { ...process.env, DISPLAY: display });
    return { ok: true, url };
  }
  throw new Error(`unknown action: ${action}`);
}

async function main() {
  startDesktop();
  await waitForPort("127.0.0.1", vncPort);

  const uri = `${utilsUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/vm-worker`;
  const websocket = new WebSocket(uri, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 15_000 });

  websocket.on("open", () => {
    websocket.send(JSON.stringify({ type: "vm.hello", token, workerId, capabilities: ["desktop", "browser", "terminal", "files"] }));
    console.log(`Interactive VM connected to utils as ${workerId}`);
  });

  websocket.on("message", async (raw, isBinary) => {
    if (isBinary) {
      if (vncSocket && !vncSocket.destroyed) vncSocket.write(raw);
      return;
    }
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === "vm.auth.failed") {
      console.error("Interactive VM authentication failed");
      websocket.close();
      return;
    }
    if (message.type === "vm.command") {
      try {
        const result = await handleCommand(message.payload ?? {});
        websocket.send(JSON.stringify({ type: "vm.response", requestId: message.requestId, ...result }));
      } catch (error) {
        websocket.send(JSON.stringify({ type: "vm.response", requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    }
  });

  let vncSocket;
  vncSocket = net.createConnection({ host: "127.0.0.1", port: vncPort });
  vncSocket.on("data", (chunk) => { if (websocket.readyState === WebSocket.OPEN) websocket.send(chunk); });
  vncSocket.on("error", (error) => console.error("VNC socket error:", error.message));
  vncSocket.on("close", () => { if (!stopping) websocket.close(); });

  const heartbeat = setInterval(() => {
    if (websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify({ type: "vm.heartbeat", workerId, ts: Date.now() }));
  }, 15_000);

  await new Promise((resolve) => websocket.on("close", resolve));
  clearInterval(heartbeat);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of [...processes].reverse()) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

await main();
await shutdown();
