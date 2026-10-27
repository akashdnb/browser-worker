import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("VM relay reconnects without restarting the desktop", async () => {
  const source = await readFile(new URL("../src/vm.js", import.meta.url), "utf8");

  assert.match(source, /async function connectRelay\(uri\)/);
  assert.match(source, /Interactive VM relay will reconnect in .*without restarting Chromium/);
  assert.match(source, /await connectRelay\(uri\)/);
  assert.match(source, /Math\.min\(backoffMs \* 2, 30_000\)/);
  assert.match(source, /if \(connection\.connected\) backoffMs = 2_000/);

  const mainSource = source.slice(source.indexOf("async function main()"), source.indexOf("async function waitForChildExit"));
  assert.doesNotMatch(mainSource, /await shutdown\(\)/);
});
