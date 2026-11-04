import http from "node:http";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function requestOptions(endpoint, requestPath, timeoutMs) {
  const base = new URL(endpoint);
  if (base.protocol !== "http:" || !LOOPBACK_HOSTS.has(base.hostname)) {
    throw new Error(`CDP endpoint must use HTTP on loopback; received ${base.origin}`);
  }
  return {
    hostname: base.hostname === "localhost" ? "127.0.0.1" : base.hostname,
    port: Number.parseInt(base.port || "80", 10),
    path: requestPath,
    method: "GET",
    timeout: timeoutMs,
    headers: { accept: "application/json" },
  };
}

/**
 * Make a direct loopback HTTP request to Chromium's CDP server.
 * Node's fetch/undici can inherit proxy configuration in some runner images;
 * node:http deliberately bypasses HTTP_PROXY/HTTPS_PROXY for localhost.
 */
export function getCdpResponse(endpoint, requestPath, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    let request;
    try {
      request = http.get(requestOptions(endpoint, requestPath, timeoutMs), (response) => {
        const chunks = [];
        response.setEncoding("utf8");
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => finish(resolve, {
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: chunks.join(""),
        }));
        response.on("error", (error) => finish(reject, error));
      });
    } catch (error) {
      finish(reject, error);
      return;
    }

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`CDP request ${requestPath} timed out after ${timeoutMs}ms`));
    });
    request.on("error", (error) => finish(reject, error));
  });
}

export async function getCdpJson(endpoint, requestPath, options) {
  const response = await getCdpResponse(endpoint, requestPath, options);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`CDP ${requestPath} returned HTTP ${response.statusCode}: ${response.body.slice(0, 300)}`);
  }
  try {
    return JSON.parse(response.body);
  } catch (error) {
    throw new Error(`CDP ${requestPath} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
