import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("VM bootstrap retries transient server failures without retrying auth failures", () => {
  const workflow = readFileSync(".github/workflows/browser-worker.yml", "utf8");
  const bootstrapLine = workflow
    .split("\n")
    .find((line) => line.includes('response="$(curl') && line.includes("$BOOTSTRAP_URL"));

  assert.ok(bootstrapLine, "VM OIDC bootstrap request must exist");
  assert.match(bootstrapLine, /--retry 8/);
  assert.match(bootstrapLine, /--retry-delay 2/);
  assert.match(bootstrapLine, /--retry-max-time 90/);
  assert.match(bootstrapLine, /--retry-connrefused/);
  assert.doesNotMatch(bootstrapLine, /--retry-all-errors/);
});
