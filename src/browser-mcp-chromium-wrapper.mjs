#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

const realChromium = process.env.BROWSER_MCP_REAL_CHROMIUM;
const gatewayUrl = process.env.UTILS_BROWSER_WORKER_URL?.replace(/\/$/, "");
const utilsBaseUrl = gatewayUrl?.replace(/\/browser-worker\/?$/, "");
const workerToken = process.env.UTILS_BROWSER_WORKER_TOKEN;
const workerId = process.env.VM_WORKER_ID ?? `github-${process.env.GITHUB_RUN_ID ?? process.pid}`;
const userDataDir = process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? "/tmp/browser-worker-profile";
const cdpPort = Number.parseInt(process.env.VM_CHROMIUM_DEBUG_PORT ?? "9222", 10);

if (!realChromium) throw new Error("BROWSER_MCP_REAL_CHROMIUM is required");
if (!gatewayUrl || !utilsBaseUrl || !workerToken) throw new Error("UTILS_BROWSER_WORKER_URL and UTILS_BROWSER_WORKER_TOKEN are required");

const extensionDir = join(userDataDir, "BrowserMCPExtension");
const bridgeUrl = `${utilsBaseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/browser-bridge`;
const bootstrapUrl = `${utilsBaseUrl}/oauth/token`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bootstrap() {
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const body = new URLSearchParams({ grant_type: "urn:render:browser-worker", resource: `${utilsBaseUrl}/browser-mcp`, worker_id: workerId });
      const response = await fetch(bootstrapUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${workerToken}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`bootstrap HTTP ${response.status}: ${payload.error_description ?? payload.error ?? "unexpected response"}`);
      if (!payload.access_token || !payload.extension_version || !payload.extension_bundle_base64) throw new Error("bootstrap response is missing required token/version/bundle fields");
      return payload;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`BrowserMCP VM bootstrap attempt ${attempt}/8 failed: ${lastError.message}`);
      if (attempt < 8) await sleep(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`BrowserMCP VM extension bootstrap failed after retries: ${lastError?.message ?? "unknown error"}`);
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (code=${code}, signal=${signal ?? "none"})`)));
  });
}

async function installIfChanged(payload) {
  const markerPath = join(extensionDir, ".installed-version");
  let installedVersion = null;
  try { installedVersion = (await readFile(markerPath, "utf8")).trim() || null; } catch {}
  if (installedVersion === payload.extension_version) {
    try {
      const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
      if (manifest.version === payload.extension_version) {
        console.log(`BrowserMCP extension ${installedVersion} already installed; reusing cached files`);
        return;
      }
    } catch {}
    console.warn("BrowserMCP version marker/manifest mismatch; refreshing extension");
  }

  const stagingRoot = `${extensionDir}.staging-${process.pid}`;
  const archivePath = `${stagingRoot}.tar.gz`;
  const unpackedDir = join(stagingRoot, "browser_extension");
  const backupDir = `${extensionDir}.previous-${process.pid}`;
  await rm(stagingRoot, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await mkdir(stagingRoot, { recursive: true });
  try {
    await writeFile(archivePath, Buffer.from(payload.extension_bundle_base64, "base64"), { mode: 0o600 });
    await run("tar", ["-xzf", archivePath, "-C", stagingRoot, "--no-same-owner", "--no-same-permissions"]);
    const manifest = JSON.parse(await readFile(join(unpackedDir, "manifest.json"), "utf8"));
    if (manifest.version !== payload.extension_version) throw new Error(`bundle manifest version ${manifest.version} differs from advertised version ${payload.extension_version}`);
    await writeFile(join(unpackedDir, ".installed-version"), payload.extension_version, { mode: 0o600 });
    await rm(backupDir, { recursive: true, force: true });
    try { await rename(extensionDir, backupDir); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await rename(unpackedDir, extensionDir);
    await rm(backupDir, { recursive: true, force: true });
    console.log(`Installed BrowserMCP extension ${payload.extension_version} (previous: ${installedVersion ?? "none"})`);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(archivePath, { force: true });
  }
}

async function fetchCdpJson(path) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`CDP endpoint ${path} returned HTTP ${response.status}`);
  return await response.json();
}

async function waitForCdp(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await fetchCdpJson("/json/version"); } catch { await sleep(500); }
  }
  throw new Error("Chromium CDP did not become ready within 60 seconds");
}

async function waitForExtensionTarget(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchCdpJson("/json/list");
      const target = targets.find((item) => item.type === "service_worker" && item.url?.startsWith("chrome-extension://") && /background\.js(?:$|\?)/.test(item.url) && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch {}
    await sleep(500);
  }
  throw new Error("BrowserMCP extension service worker did not start within 60 seconds");
}

async function authenticateExtension(accessToken) {
  const target = await waitForExtensionTarget();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to BrowserMCP service worker")), 10_000);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  try {
    const id = 1;
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off("message", listener); reject(new Error("Timed out injecting BrowserMCP extension storage")); }, 10_000);
      const listener = (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (message.id !== id) return;
        clearTimeout(timer);
        socket.off("message", listener);
        if (message.error) reject(new Error(message.error.message ?? "CDP Runtime.evaluate failed"));
        else resolve(message.result?.result?.value);
      };
      socket.on("message", listener);
    });
    socket.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: {
        expression: `chrome.storage.local.set({ bridgeUrl: ${JSON.stringify(bridgeUrl)}, accessToken: ${JSON.stringify(accessToken)} }).then(() => true)`,
        awaitPromise: true,
        returnByValue: true,
      },
    }));
    if (await responsePromise !== true) throw new Error("BrowserMCP extension storage injection was not confirmed");
    console.log("BrowserMCP extension authenticated against the gateway");
  } finally {
    socket.close();
  }
}

const payload = await bootstrap();
await mkdir(userDataDir, { recursive: true });
await installIfChanged(payload);
const child = spawn(realChromium, [
  ...process.argv.slice(2),
  `--load-extension=${extensionDir}`,
  `--disable-extensions-except=${extensionDir}`,
], { stdio: ["ignore", "inherit", "inherit"] });
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

let authError = null;
const auth = (async () => {
  await waitForCdp();
  await authenticateExtension(payload.access_token);
})().catch((error) => {
  authError = error;
  console.error("BrowserMCP extension authentication failed:", error instanceof Error ? error.message : String(error));
  shutdown("SIGTERM");
});
const exitCode = await new Promise((resolve) => child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0))));
await auth;
if (authError) process.exitCode = 1;
else process.exitCode = exitCode;
