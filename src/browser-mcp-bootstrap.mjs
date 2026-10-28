import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

function formBody(values) {
  return new URLSearchParams(values).toString();
}

function httpBaseUrl(baseUrl) {
  return baseUrl
    .replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:")
    .replace(/\/browser-worker\/?$/, "");
}

function bridgeBaseUrl(baseUrl) {
  return baseUrl
    .replace(/^https:/, "wss:")
    .replace(/^http:/, "ws:")
    .replace(/\/browser-worker\/?$/, "")
    .replace(/\/$/, "");
}

export function compareExtensionVersions(left, right) {
  const a = String(left).split(".").map((part) => Number.parseInt(part, 10));
  const b = String(right).split(".").map((part) => Number.parseInt(part, 10));
  if (a.some((part) => !Number.isInteger(part)) || b.some((part) => !Number.isInteger(part))) {
    throw new Error(`Invalid extension version: ${left} vs ${right}`);
  }
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

export function extensionBundleFingerprint(bundleBase64) {
  return createHash("sha256").update(String(bundleBase64)).digest("hex");
}

async function requestBootstrapPayload({ baseUrl, workerToken, workerId }) {
  const httpBase = httpBaseUrl(baseUrl);
  const resource = `${httpBase}/browser-mcp`;
  const response = await fetch(`${httpBase}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${workerToken}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: formBody({
      grant_type: "urn:render:browser-worker",
      resource,
      worker_id: workerId || "browser-worker-vm",
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`BrowserMCP VM bootstrap failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  const payload = JSON.parse(text);
  if (typeof payload.access_token !== "string" || !payload.access_token) throw new Error("BrowserMCP VM bootstrap did not return an access token");
  if (typeof payload.extension_bundle_base64 !== "string" || payload.extension_bundle_format !== "tar.gz") {
    throw new Error("BrowserMCP VM bootstrap did not return an extension bundle");
  }
  if (typeof payload.extension_version !== "string" || !payload.extension_version) {
    throw new Error("BrowserMCP VM bootstrap did not return an extension version");
  }
  return payload;
}

async function readInstalledVersion(extensionDir) {
  try {
    const manifest = JSON.parse(await readFile(`${extensionDir}/manifest.json`, "utf8"));
    if (typeof manifest.version !== "string" || !manifest.version) return null;
    return manifest.version;
  } catch {
    return null;
  }
}

async function readInstalledFingerprint(extensionDir) {
  try {
    const fingerprint = (await readFile(`${extensionDir}/.installed-fingerprint`, "utf8")).trim();
    return fingerprint || null;
  } catch {
    return null;
  }
}

async function readPendingUpdate(extensionDir) {
  try {
    return JSON.parse(await readFile(`${extensionDir}/.update-pending`, "utf8"));
  } catch {
    return null;
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function extractBundle(archivePath, stagingRoot) {
  return spawnSync("tar", ["-xzf", archivePath, "-C", stagingRoot, "--no-same-owner", "--no-same-permissions"], { encoding: "utf8" });
}

async function validateStagedExtension(unpackedDir, expectedVersion) {
  const manifest = JSON.parse(await readFile(`${unpackedDir}/manifest.json`, "utf8"));
  if (manifest.version !== expectedVersion) {
    throw new Error(`bundle manifest version ${manifest.version} differs from advertised version ${expectedVersion}`);
  }
  if (typeof manifest.background?.service_worker !== "string" || !manifest.background.service_worker) {
    throw new Error("BrowserMCP extension manifest does not declare a service worker");
  }
  const serviceWorkerPath = `${unpackedDir}/${manifest.background.service_worker}`;
  const serviceWorker = await readFile(serviceWorkerPath, "utf8");
  if (!serviceWorker.trim()) throw new Error("BrowserMCP extension service worker file is empty");
}

async function recoverInterruptedInstall(extensionDir) {
  const backupDir = `${extensionDir}.previous`;
  if (!(await pathExists(extensionDir)) && (await pathExists(backupDir))) {
    await rename(backupDir, extensionDir);
    console.warn(`Recovered BrowserMCP extension from interrupted update backup at ${backupDir}`);
  }
}

export async function prepareBrowserMcpExtension({ baseUrl, workerToken, workerId, extensionDir }) {
  if (!baseUrl || !workerToken) throw new Error("UTILS_BROWSER_WORKER_URL and UTILS_BROWSER_WORKER_TOKEN are required for BrowserMCP VM bootstrap");
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const payload = await requestBootstrapPayload({ baseUrl: normalizedBaseUrl, workerToken, workerId });
  const backupDir = `${extensionDir}.previous`;
  const stagingRoot = `${extensionDir}.staging-${process.pid}`;
  const archivePath = `${stagingRoot}.tar.gz`;
  const authoritativeFingerprint = extensionBundleFingerprint(payload.extension_bundle_base64);

  await mkdir(extensionDir.substring(0, extensionDir.lastIndexOf("/")) || ".", { recursive: true });
  await recoverInterruptedInstall(extensionDir);

  const installedVersion = await readInstalledVersion(extensionDir);
  const installedFingerprint = await readInstalledFingerprint(extensionDir);
  const pendingUpdate = await readPendingUpdate(extensionDir);
  if (pendingUpdate && !(await pathExists(backupDir))) {
    await rm(`${extensionDir}/.update-pending`, { force: true });
  }
  if (installedVersion) {
    const comparison = compareExtensionVersions(installedVersion, payload.extension_version);
    if (pendingUpdate && await pathExists(backupDir)) {
      console.warn(`BrowserMCP extension ${installedVersion} has an unvalidated update; keeping rollback backup while service-worker validation runs`);
      return { extensionDir, accessToken: payload.access_token, extensionVersion: installedVersion, authoritativeVersion: payload.extension_version, previousVersion: pendingUpdate.previousVersion ?? installedVersion, updated: true, backupDir };
    }
    // Version numbers are not sufficient to identify the VM bundle: the extension
    // code can change without a manifest bump. Reinstall equal-version bundles when
    // their content fingerprint changes, while never downgrading a newer installed version.
    if (comparison > 0 || (comparison === 0 && installedFingerprint === authoritativeFingerprint)) {
      await rm(backupDir, { recursive: true, force: true });
      console.log(`BrowserMCP extension ${installedVersion} already satisfies authoritative version ${payload.extension_version}; reusing cached files${comparison > 0 ? " (installed version is newer; no downgrade)" : ""}`);
      return { extensionDir, accessToken: payload.access_token, extensionVersion: installedVersion, authoritativeVersion: payload.extension_version, previousVersion: installedVersion, updated: false, backupDir: null, bundleFingerprint: installedFingerprint };
    }
  }

  await rm(stagingRoot, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await mkdir(stagingRoot, { recursive: true });
  try {
    await writeFile(archivePath, Buffer.from(payload.extension_bundle_base64, "base64"), { mode: 0o600 });
    const extraction = extractBundle(archivePath, stagingRoot);
    if (extraction.status !== 0) throw new Error(`Unable to extract BrowserMCP extension bundle: ${extraction.stderr || extraction.stdout || "tar failed"}`);

    const unpackedDir = await pathExists(`${stagingRoot}/browser_extension`) ? `${stagingRoot}/browser_extension` : stagingRoot;
    await validateStagedExtension(unpackedDir, payload.extension_version);

    let hadPrevious = false;
    if (await pathExists(extensionDir)) {
      await rename(extensionDir, backupDir);
      hadPrevious = true;
    }
    if (hadPrevious) {
      await writeFile(`${unpackedDir}/.update-pending`, JSON.stringify({ previousVersion: installedVersion, targetVersion: payload.extension_version }), { mode: 0o600 });
    }
    await writeFile(`${unpackedDir}/.installed-version`, payload.extension_version, { mode: 0o600 });
    await writeFile(`${unpackedDir}/.installed-fingerprint`, authoritativeFingerprint, { mode: 0o600 });
    try {
      await rename(unpackedDir, extensionDir);
    } catch (error) {
      if (hadPrevious && !(await pathExists(extensionDir)) && (await pathExists(backupDir))) await rename(backupDir, extensionDir);
      throw error;
    }

    console.log(`Prepared BrowserMCP extension ${payload.extension_version} (previous: ${installedVersion ?? "none"}, fingerprint: ${authoritativeFingerprint.slice(0, 12)}); service worker manifest validated`);
    return { extensionDir, accessToken: payload.access_token, extensionVersion: payload.extension_version, authoritativeVersion: payload.extension_version, previousVersion: installedVersion, updated: true, backupDir: hadPrevious ? backupDir : null, bundleFingerprint: authoritativeFingerprint };
  } catch (error) {
    console.error(`BrowserMCP extension update failed; keeping ${installedVersion ?? "no installed version"}:`, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(archivePath, { force: true });
  }
}

export async function finalizeBrowserMcpExtensionUpdate({ extensionDir, backupDir }) {
  if (extensionDir) await rm(`${extensionDir}/.update-pending`, { force: true });
  if (!backupDir) return;
  await rm(backupDir, { recursive: true, force: true });
}

export async function rollbackBrowserMcpExtensionUpdate({ extensionDir, backupDir }) {
  if (!backupDir) throw new Error("BrowserMCP extension update has no previous version to roll back to");
  const rollbackStaging = `${extensionDir}.rollback-${process.pid}`;
  await rm(rollbackStaging, { recursive: true, force: true });
  if (!(await pathExists(backupDir))) throw new Error(`BrowserMCP extension rollback backup is missing: ${backupDir}`);
  try {
    if (await pathExists(extensionDir)) await rename(extensionDir, rollbackStaging);
    await rename(backupDir, extensionDir);
    await rm(rollbackStaging, { recursive: true, force: true });
    console.warn(`Rolled BrowserMCP extension back to ${await readInstalledVersion(extensionDir)}`);
  } catch (error) {
    if (!(await pathExists(extensionDir)) && (await pathExists(rollbackStaging))) await rename(rollbackStaging, extensionDir);
    throw error;
  }
}

async function discoverExtensionTarget(cdpPort, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        lastTargets = await response.json();
        const target = lastTargets.find((item) => item.type === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\//.test(item.url || ""));
        if (target) return target;
      }
    } catch {
      // Chromium can take a few seconds to bind the CDP port after launch.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`BrowserMCP extension service worker was not found on CDP ${cdpPort}; targets=${JSON.stringify(lastTargets).slice(0, 1000)}`);
}

function cdpEvaluate(targetWebSocketUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(targetWebSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out evaluating BrowserMCP extension bootstrap script"));
    }, 15_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error) return reject(new Error(message.error.message || "CDP Runtime.evaluate failed"));
      const result = message.result?.result;
      if (result?.subtype === "error" || result?.description?.startsWith("Error")) {
        return reject(new Error(result.description || result.value || "BrowserMCP extension evaluation failed"));
      }
      resolve(result?.value);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("BrowserMCP extension CDP WebSocket failed"));
    });
  });
}

export async function bootstrapBrowserMcp({ cdpPort, baseUrl, workerToken, workerId, accessToken, required = false }) {
  if (!baseUrl) throw new Error("UTILS_BROWSER_WORKER_URL is required for BrowserMCP bootstrap");
  if (!accessToken && !workerToken) {
    const message = "BrowserMCP VM auto-auth is enabled but no worker token or access token was configured";
    if (required) throw new Error(message);
    console.warn(message);
    return { enabled: false };
  }

  const target = await discoverExtensionTarget(cdpPort);
  const extensionId = new URL(target.url).hostname;
  const token = accessToken || (await requestBootstrapPayload({ baseUrl: baseUrl.replace(/\/$/, ""), workerToken, workerId })).access_token;
  const bridgeUrl = `${bridgeBaseUrl(baseUrl)}/browser-bridge`;
  const result = await cdpEvaluate(
    target.webSocketDebuggerUrl,
    `chrome.storage.local.set(${JSON.stringify({ accessToken: token, bridgeUrl, vmAutoAuth: true })}).then(() => chrome.storage.local.get({ accessToken: "", bridgeUrl: "" }))`,
  );
  if (!result || result.accessToken !== token || result.bridgeUrl !== bridgeUrl) {
    throw new Error("BrowserMCP extension token bootstrap could not be verified in chrome.storage.local");
  }
  console.log(`BrowserMCP extension ${extensionId} loaded and authenticated automatically`);
  return { enabled: true, extensionId };
}
