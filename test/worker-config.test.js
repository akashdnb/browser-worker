import assert from "node:assert/strict";
import test from "node:test";

import { parseWorkerTiming } from "../src/worker-config.js";

test("managed VMs do not validate the unused legacy renewal window", () => {
  const timing = parseWorkerTiming({
    VM_ID: "vm-managed",
    WORKER_MAX_SECONDS: "540",
  });

  assert.deepEqual(timing, { maxSeconds: 540, renewalLeadSeconds: 900 });
});

test("legacy workers still require a renewal window shorter than their lifetime", () => {
  assert.throws(
    () => parseWorkerTiming({ WORKER_MAX_SECONDS: "540" }),
    /WORKER_RENEWAL_LEAD_SECONDS must be at least 60 and less than WORKER_MAX_SECONDS/,
  );
});

test("legacy workers accept a valid renewal window", () => {
  const timing = parseWorkerTiming({
    WORKER_MAX_SECONDS: "20400",
    WORKER_RENEWAL_LEAD_SECONDS: "900",
  });

  assert.deepEqual(timing, { maxSeconds: 20400, renewalLeadSeconds: 900 });
});
