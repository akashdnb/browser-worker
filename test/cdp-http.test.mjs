import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { getCdpJson, getCdpResponse } from "../src/cdp-http.mjs";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("CDP requests use direct loopback HTTP even when proxy variables are configured", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome/test" }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  const port = await listen(server);
  const oldHttpProxy = process.env.HTTP_PROXY;
  const oldHttpsProxy = process.env.HTTPS_PROXY;
  process.env.HTTP_PROXY = "http://127.0.0.1:1";
  process.env.HTTPS_PROXY = "http://127.0.0.1:1";

  try {
    const endpoint = `http://127.0.0.1:${port}`;
    assert.deepEqual(await getCdpJson(endpoint, "/json/version"), { Browser: "Chrome/test" });
    const response = await getCdpResponse(endpoint, "/json/version");
    assert.equal(response.statusCode, 200);
  } finally {
    if (oldHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = oldHttpProxy;
    if (oldHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = oldHttpsProxy;
    await close(server);
  }
});

test("CDP client rejects non-loopback endpoints", async () => {
  await assert.rejects(
    getCdpResponse("https://example.com", "/json/version"),
    /must use HTTP on loopback/,
  );
});

test("CDP JSON client reports non-success responses with their status", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("starting");
  });
  const port = await listen(server);

  try {
    await assert.rejects(
      getCdpJson(`http://127.0.0.1:${port}`, "/json/version"),
      /returned HTTP 503: starting/,
    );
  } finally {
    await close(server);
  }
});
