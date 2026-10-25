import { mkdir, rm, writeFile } from "node:fs/promises";
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
  return payload;
}

export async function prepareBrowserMcpExtension({ baseUrl, workerToken, workerId, extensionDir }) {
  if (!baseUrl || !workerToken) throw new Error("UTILS_BROWSER_WORKER_URL and UTILS_BROWSER_WORKER_TOKEN are required for BrowserMCP VM bootstrap");
  const payload = await requestBootstrapPayload({ baseUrl: baseUrl.replace(/\/$/, ""), workerToken, workerId });
  await rm(extensionDir, { recursive: true, force: true });
  await mkdir(extensionDir, { recursive: true });
  const archivePath = `${extensionDir}.tar.gz`;
  await writeFile(archivePath, Buffer.from(payload.extension_bundle_base64, "base64"), { mode: 0o600 });
  const extraction = spawnSync("tar", ["-xzf", archivePath, "-C", extensionDir, "--strip-components=1"], { encoding: "utf8" });
  await rm(archivePath, { force: true });
  if (extraction.status !== 0) throw new Error(`Unable to extract BrowserMCP extension bundle: ${extraction.stderr || extraction.stdout || "tar failed"}`);
  return { extensionDir, accessToken: payload.access_token };
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
