import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { monitorProcessExit } from "../src/process-monitor.js";

function createChild() {
  return new EventEmitter();
}

function createLogger() {
  const errors = [];
  return { errors, error: (message) => errors.push(message) };
}

test("non-critical process that exits successfully is ignored", () => {
  const child = createChild();
  const logger = createLogger();
  let restartRequested = false;

  monitorProcessExit(child, "chromium --new-tab", {
    logger,
    onCriticalExit: () => { restartRequested = true; },
  });
  child.emit("exit", 0, null);

  assert.deepEqual(logger.errors, []);
  assert.equal(restartRequested, false);
});

test("non-critical process with a failure is logged", () => {
  const child = createChild();
  const logger = createLogger();

  monitorProcessExit(child, "chromium --new-tab", { logger });
  child.emit("exit", 1, null);

  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0], /chromium --new-tab code=1/);
});

test("critical process clean exit triggers relay restart", () => {
  const child = createChild();
  const logger = createLogger();
  const failures = [];

  monitorProcessExit(child, "chromium", {
    critical: true,
    logger,
    onCriticalExit: (details) => failures.push(details),
  });
  child.emit("exit", 0, null);

  assert.deepEqual(failures, [{ command: "chromium", code: 0, signal: null }]);
  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0], /Critical VM process exited/);
});

test("critical process failure triggers relay restart", () => {
  const child = createChild();
  const failures = [];

  monitorProcessExit(child, "Xvfb", {
    critical: true,
    logger: createLogger(),
    onCriticalExit: (details) => failures.push(details),
  });
  child.emit("exit", 2, "SIGTERM");

  assert.deepEqual(failures, [{ command: "Xvfb", code: 2, signal: "SIGTERM" }]);
});

test("intentional shutdown does not restart the relay", () => {
  const child = createChild();
  const logger = createLogger();
  let restartRequested = false;

  monitorProcessExit(child, "chromium", {
    critical: true,
    isStopping: () => true,
    logger,
    onCriticalExit: () => { restartRequested = true; },
  });
  child.emit("exit", 0, null);

  assert.deepEqual(logger.errors, []);
  assert.equal(restartRequested, false);
});
