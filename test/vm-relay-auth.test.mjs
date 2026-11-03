import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("VM relay only reports connected after gateway authentication", async () => {
  const source = await readFile(new URL("../src/vm.js", import.meta.url), "utf8");
  const openHandler = source.slice(source.indexOf('websocket.on("open"'), source.indexOf('websocket.on("message"'));

  assert.match(openHandler, /type: "vm\.hello"/);
  assert.match(openHandler, /Timed out waiting for vm\.auth\.ok/);
  assert.doesNotMatch(openHandler, /connected = true/);
  assert.match(source, /message\.type === "vm\.auth\.ok"[\s\S]*?connected = true/);
  assert.match(source, /message\.type === "vm\.auth\.failed"/);
});
