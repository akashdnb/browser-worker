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
if (!gatewayUrl || !utilsBaseUrl || !workerToken) {
  throw new Error("UTILS_BROWSER_WORKER_URL and UTILS_BROWSER_WORKER_TOKEN are required for BrowserMCP bootstrap");
}

const extensionDir = join(userDataDir, "BrowserMCPExtension");
const markerPath = join(extensionDir, ".installed-version");
const bridgeUrl = `${utilsBaseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/browser-bridge`;
const bootstrapUrl = `${utilsBaseUrl}/oauth/token`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootstrap() {
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const body = new URLSearchParams({
        grant_type: "urn:render:browser-worker",
        resource: `${utilsBaseUrl}/browser-mcp`,
        worker_id: workerId,
      });
      const response = await fetch(bootstrapUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workerToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`bootstrap HTTP ${response.status}: ${payload.error_description ?? payload.error ?? "unexpected response"}`);
      }
      if (!payload.access_token || !payload.extension_version || !payload.extension_bundle_base64) {
        throw new Error("bootstrap response is missing access_token, extension_version, or extension_bundle_base64");
      }
      return payload;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`BrowserMCP VM bootstrap attempt ${attempt}/8 failed: ${lastError.message}`);
      if (attempt < 8) await sleep(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`BrowserMCP VM extension bootstrap failed after retries: ${lastError?.message ?? "unknown error"}`);
}

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (code=${code}, signal=${signal ?? "none"})`));
    });
  });
}

async function readInstalledVersion() {
  try {
    const version = (await readFile(markerPath, "utf8")).trim();
    return version || null;
  } catch {
    return null;
  }
}

async function installIfChanged(payload) {
  const installedVersion = await readInstalledVersion();
  if (installedVersion === payload.extension_version) {
    const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
    if (manifest.version === payload.extension_version) {
      console.log(`BrowserMCP extension ${installedVersion} already installed; reusing cached files`);
      return;
    }
    console.warn("BrowserMCP extension version marker did not match manifest; reinstalling");
  }

  const stagingDir = `${extensionDir}.staging-${process.pid}`;
  const archivePath = `${stagingDir}.tar.gz`;
  await rm(stagingDir, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await mkdir(stagingDir, { recursive: true });

  try {
    await writeFile(archivePath, Buffer.from(payload.extension_bundle_base64, "base64"), { mode: 0o600 });
    await run("tar", ["-xzf", archivePath, "-C", stagingDir, "--no-same-owner", "--no-same-permissions"]);
    const unpackedDir = join(stagingDir, "browser_extension");
    const manifest = JSON.parse(await readFile(join(unpackedDir, "manifest.json"), "utf8"));
    if (manifest.version !== payload.extension_version) {
      throw new Error(`extension bundle manifest version ${manifest.version} does not match advertised version ${payload.extension_version}`);
    }
    await writeFile(join(unpackedDir, ".installed-version"), payload.extension_version, { mode: 0o600 });
    const backupDir = `${extensionDir}.previous-${process.pid}`;
    await rm(backupDir, { recursive: true, force: true });
    try {
      await rename(extensionDir, backupDir);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(unpackedDir, extensionDir);
    await rm(backupDir, { recursive: true, force: true });
    console.log(`Installed BrowserMCP extension ${payload.extension_version} (previous: ${installedVersion ?? "none"})`);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(archivePath, { force: true });
  }
}

async function waitForCdp(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`Chromium CDP did not become ready: ${lastError}`);
}

async function getTargets() {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
  return await response.json();
}

async function waitForExtensionTarget(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await getTargets();
      const target = targets.find((item) =>
        item.type === "service_worker" &&
        item.url?.startsWith("chrome-extension://") &&
        /background\.js(?:$|\?)/.test(item.url) &&
        item.webSocketDebuggerUrl
      );
      if (target) return target;
    } catch (error) {
      console.warn(`Waiting for BrowserMCP extension target: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(500);
  }
  throw new Error("BrowserMCP extension service worker did not start within 60 seconds");
}

async function sendCdpCommand(socket, id, method, params = {}) {
  const message = JSON.stringify({ id, method, params });
  await new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) return reject(new Error("CDP WebSocket is not open"));
    socket.send(message, (error) => error ? reject(error) : resolve());
  });
}

async function authenticateExtension() {
  const target = await waitForExtensionTarget();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to BrowserMCP service worker")), 10_000);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });

  try {
    const id = 1;
    const resultPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out setting BrowserMCP extension storage")), 10_000);
      const onMessage = (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (message.id !== id) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        if (message.error) reject(new Error(message.error.message ?? "CDP Runtime.evaluate failed"));
        else resolve(message.result?.result?.value);
      };
      socket.on("message", onMessage);
    });
    await sendCdpCommand(socket, id, "Runtime.evaluate", {
      expression: `chrome.storage.local.set({ bridgeUrl: ${JSON.stringify(bridgeUrl)}, accessToken: ${JSON.stringify((await bootstrapToken).access_token)} }).then(() => true)`,
      awaitPromise: true,
      returnByValue: true,
    });
    const ok = await resultPromise;
    if (ok !== true) throw new Error("BrowserMCP extension storage injection was not confirmed");
    console.log("BrowserMCP extension authenticated against the gateway");
  } finally {
    socket.close();
  }
}

let bootstrapToken;
let stopping = false;
const child = await (async () => {
  const payload = await bootstrap();
  bootstrapToken = Promise.resolve(payload);
  await installIfChanged(payload);
  const args = process.argv.slice(2);
  args.push(`--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`);
  const chromium = spawn(realChromium, args, { stdio: ["ignore", "inherit", "inherit"] });
  chromium.once("error", (error) => {
    console.error("Failed to launch Chromium with BrowserMCP extension:", error);
    process.exitCode = 1;
  });
  const auth = (async () => {
    await waitForCdp();
    await authenticateExtension();
  })();
  auth.catch((error) => {
    console.error("BrowserMCP extension authentication failed:", error instanceof Error ? error.message : String(error));
    try { chromium.kill("SIGTERM"); } catch {}
    process.exitCode = 1;
  });
  return chromium;
})();

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (!child.killed) child.kill(signal);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const exitCode = await new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
process.exitCode = exitCode;
