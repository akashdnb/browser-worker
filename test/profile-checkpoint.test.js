import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProfileCheckpoint, profileIsReady } from "../src/profile-checkpoint.mjs";
import { desktopProcessEnvironment, removeChromiumAtomicWriteFiles } from "../src/chromium-profile-cleanup.mjs";

async function makeProfile(root) {
  const profile = path.join(root, "profile");
  await mkdir(path.join(profile, "Default", "Sessions"), { recursive: true });
  await mkdir(path.join(profile, "Default", "Cache"), { recursive: true });
  await writeFile(path.join(profile, "Local State"), "{\"profile\":true}");
  await writeFile(path.join(profile, "Default", "Preferences"), "{\"prefs\":true}");
  await writeFile(path.join(profile, "Default", "Sessions", "Tabs_1"), "open tabs");
  await writeFile(path.join(profile, "Default", "Cache", "disposable"), "cache");
  await writeFile(path.join(profile, "SingletonLock"), "lock");
  await writeFile(path.join(profile, ".org.chromium.Chromium.Local State.tmp"), "stale atomic write");
  await writeFile(path.join(profile, "Default", ".org.chromium.Chromium.Network Persistent State.tmp"), "nested stale write");
  await writeFile(path.join(profile, "Default", "Sessions", ".org.chromium.Chromium.Session.tmp"), "deep stale write");
  return profile;
}

test("Chromium atomic-write files are removed recursively without deleting profile data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chromium-profile-cleanup-"));
  try {
    const profile = path.join(root, "profile");
    await mkdir(path.join(profile, "Default", "Sessions"), { recursive: true });
    await writeFile(path.join(profile, "Default", ".org.chromium.Chromium.Network.tmp"), "stale");
    await writeFile(path.join(profile, "Default", "Sessions", ".org.chromium.Chromium.Session.tmp"), "stale");
    await writeFile(path.join(profile, "Default", "Sessions", "Tabs_1"), "keep");
    assert.equal(await removeChromiumAtomicWriteFiles(profile), 2);
    await assert.rejects(stat(path.join(profile, "Default", ".org.chromium.Chromium.Network.tmp")));
    await assert.rejects(stat(path.join(profile, "Default", "Sessions", ".org.chromium.Chromium.Session.tmp")));
    assert.equal(await readFile(path.join(profile, "Default", "Sessions", "Tabs_1"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop environment clears invalid inherited DBus addresses", () => {
  const env = desktopProcessEnvironment({
    PATH: "/usr/bin",
    DBUS_SESSION_BUS_ADDRESS: "autolaunch:",
    DBUS_SYSTEM_BUS_ADDRESS: "invalid",
    DBUS_STARTER_ADDRESS: "autolaunch:",
    DBUS_STARTER_BUS_TYPE: "session",
  }, ":99");
  assert.equal(env.DISPLAY, ":99");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(Object.keys(env).some((key) => key.startsWith("DBUS_")), false);
});

test("profile readiness rejects missing/empty Chromium metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "profile-checkpoint-"));
  try {
    assert.equal(await profileIsReady(root), false);
    await mkdir(path.join(root, "Default"), { recursive: true });
    await writeFile(path.join(root, "Local State"), "");
    await writeFile(path.join(root, "Default", "Preferences"), "{}");
    assert.equal(await profileIsReady(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint is valid, omits locks/cache, and preserves live profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "profile-checkpoint-"));
  try {
    const profile = await makeProfile(root);
    const outputDir = path.join(root, "artifacts");
    const { archivePath } = await createProfileCheckpoint({ profileDir: profile, outputDir });

    assert.equal((await stat(archivePath)).size > 0, true);
    assert.equal(await readFile(path.join(profile, "SingletonLock"), "utf8"), "lock");
    assert.equal(await readFile(path.join(profile, "Default", "Cache", "disposable"), "utf8"), "cache");
    const listing = await new Promise((resolve, reject) => {
      const child = spawn("tar", ["-tzf", archivePath], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });
    assert.match(listing, /browser-worker-profile\/Default\/Sessions\/Tabs_1/);
    assert.doesNotMatch(listing, /SingletonLock/);
    assert.equal(listing.includes(".org.chromium."), false);
    assert.doesNotMatch(listing, /Default\/Cache\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("checkpoint runner stays alive for periodic saves until shutdown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "profile-checkpoint-runner-"));
  let child;
  try {
    const profile = await makeProfile(root);
    const outputDir = path.join(root, "live-checkpoint");
    child = spawn(
      process.execPath,
      [path.resolve("src/profile-checkpoint-runner.mjs")],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          GITHUB_ACTIONS: "false",
          PLAYWRIGHT_MCP_USER_DATA_DIR: profile,
          BROWSER_WORKER_CHECKPOINT_DIR: outputDir,
          BROWSER_WORKER_CHECKPOINT_SECONDS: "15",
          BROWSER_WORKER_CHECKPOINT_UPLOAD_SECONDS: "60",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    const exited = new Promise((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(child.exitCode, null, `runner exited before its next interval: ${output}`);

    child.kill("SIGTERM");
    const result = await exited;
    assert.equal(result.code, 0, `runner did not shut down cleanly: ${output}`);
    assert.equal((await stat(path.join(outputDir, "browser-worker-profile.tar.gz"))).size > 0, true);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
