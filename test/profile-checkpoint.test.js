import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProfileCheckpoint, profileIsReady } from "../src/profile-checkpoint.mjs";

async function makeProfile(root) {
  const profile = path.join(root, "profile");
  await mkdir(path.join(profile, "Default", "Sessions"), { recursive: true });
  await mkdir(path.join(profile, "Default", "Cache"), { recursive: true });
  await writeFile(path.join(profile, "Local State"), "{\"profile\":true}");
  await writeFile(path.join(profile, "Default", "Preferences"), "{\"prefs\":true}");
  await writeFile(path.join(profile, "Default", "Sessions", "Tabs_1"), "open tabs");
  await writeFile(path.join(profile, "Default", "Cache", "disposable"), "cache");
  await writeFile(path.join(profile, "SingletonLock"), "lock");
  return profile;
}

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
      const { spawn } = await import("node:child_process");
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
    assert.doesNotMatch(listing, /Default\/Cache\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
