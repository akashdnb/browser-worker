import { createHash, randomBytes } from "node:crypto";

const OAUTH_SCOPE = "render:manage";
const CALLBACK_PATH = "/browser-mcp/callback";

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function formBody(values) {
  return new URLSearchParams(values).toString();
}

async function responseText(response, label) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  return text;
}

async function discoverExtensionTarget(cdpPort, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (response.ok) {
      lastTargets = await response.json();
      const target = lastTargets.find((item) => item.type === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\//.test(item.url || ""));
      if (target) return target;
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

async function requestAccessToken({ baseUrl, extensionId, username, password }) {
  const redirectUri = `https://${extensionId}.chromiumapp.org${CALLBACK_PATH}`;
  const resource = `${baseUrl}/browser-mcp`;
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier, "ascii").digest());
  const state = base64Url(randomBytes(24));

  const registrationResponse = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: OAUTH_SCOPE,
      client_name: "BrowserMCP VM",
    }),
  });
  const registrationText = await responseText(registrationResponse, "BrowserMCP OAuth client registration");
  const registration = JSON.parse(registrationText);
  const clientId = registration.client_id;
  if (typeof clientId !== "string" || !clientId) throw new Error("BrowserMCP OAuth registration did not return a client_id");

  const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    scope: OAUTH_SCOPE,
  });

  const authorizeResponse = await fetch(authorizeUrl, { headers: { accept: "text/html" } });
  const authorizeHtml = await responseText(authorizeResponse, "BrowserMCP OAuth authorization page");
  const formTokenMatch = authorizeHtml.match(/name=['"]form_token['"]\s+value=['"]([^'"]+)['"]/i);
  if (!formTokenMatch) throw new Error("BrowserMCP OAuth authorization form did not contain a form token");

  const completeResponse = await fetch(`${baseUrl}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
    body: formBody({
      form_token: formTokenMatch[1],
      username,
      password,
      consent: "yes",
    }),
  });
  if (completeResponse.status < 300 || completeResponse.status >= 400) {
    const text = await completeResponse.text();
    throw new Error(`BrowserMCP OAuth authorization failed with HTTP ${completeResponse.status}: ${text.slice(0, 500)}`);
  }
  const callbackLocation = completeResponse.headers.get("location");
  if (!callbackLocation) throw new Error("BrowserMCP OAuth authorization did not return a callback location");
  const callback = new URL(callbackLocation);
  if (callback.searchParams.get("state") !== state) throw new Error("BrowserMCP OAuth callback state mismatch");
  if (callback.searchParams.get("iss") !== baseUrl) throw new Error("BrowserMCP OAuth callback issuer mismatch");
  const code = callback.searchParams.get("code");
  if (!code) throw new Error(`BrowserMCP OAuth callback did not contain an authorization code (${callback.searchParams.get("error") || "unknown error"})`);

  const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: formBody({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource,
    }),
  });
  const tokenText = await responseText(tokenResponse, "BrowserMCP OAuth token exchange");
  const token = JSON.parse(tokenText);
  if (typeof token.access_token !== "string" || !token.access_token) throw new Error("BrowserMCP OAuth token response did not contain an access_token");
  return token.access_token;
}

export async function bootstrapBrowserMcp({ cdpPort, baseUrl, accessToken, username, password, required = false }) {
  if (!baseUrl) throw new Error("UTILS_BROWSER_WORKER_URL is required for BrowserMCP bootstrap");
  if (!accessToken && (!username || !password)) {
    const message = "BrowserMCP VM auto-auth is enabled but no access token or OAuth credentials were configured";
    if (required) throw new Error(message);
    console.warn(message);
    return { enabled: false };
  }

  const target = await discoverExtensionTarget(cdpPort);
  const extensionId = new URL(target.url).hostname;
  const token = accessToken || await requestAccessToken({ baseUrl: baseUrl.replace(/\/$/, ""), extensionId, username, password });
  const bridgeUrl = `${baseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:").replace(/\/$/, "")}/browser-bridge`;
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
