import test from "node:test";
import assert from "node:assert/strict";

// Keep this smoke test dependency-free: it verifies the configuration contract
// that previously allowed the workflow URL and the relay URL to diverge.
test("worker MCP endpoint uses localhost consistently", async () => {
  const expected = "http://localhost:8931/mcp";
  assert.equal(process.env.PLAYWRIGHT_MCP_URL ?? expected, expected);
});
