import { spawn } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const LOCK_NAMES = ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"];
const DISPOSABLE_PATHS = [
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "Default/GrShaderCache",
  "Default/ShaderCache",
  "Crashpad",
  "Crash Reports",
  "BrowserMetrics",
  "GraphiteDawnCache",
  "GrShaderCache",
];

export async function profileIsReady(profileDir) {
  try {
    const [localState, preferences] = await Promise.all([
      stat(resolve(profileDir, "Local State")),
      stat(resolve(profileDir, "Default/Preferences")),
    ]);
    return localState.isFile() && localState.size > 0 &&
      preferences.isFile() && preferences.size > 0;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code=${code}, signal=${signal}`));
    });
  });
}

/**
 * Snapshot the profile without stopping Chromium. The live directory is never
 * cleaned or mutated: only a private staging copy has process locks/caches
 * removed. Rename publishes a complete archive atomically to local consumers.
 */
export async function createProfileCheckpoint({
  profileDir,
  outputDir,
  archiveName = "browser-worker-profile.tar.gz",
}) {
  const source = resolve(profileDir);
  const destinationDir = resolve(outputDir);
  if (!(await profileIsReady(source))) {
    throw new Error(`Chromium profile is not ready at ${source}; refusing to checkpoint an empty profile`);
  }

  await mkdir(destinationDir, { recursive: true });
  const stage = resolve(destinationDir, `.profile-checkpoint-${process.pid}-${Date.now()}`);
  const stagedProfile = resolve(stage, "browser-worker-profile");
  const archivePath = resolve(destinationDir, archiveName);
  const tempArchivePath = resolve(destinationDir, `.${archiveName}.${process.pid}.tmp`);

  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    await run("cp", ["-a", source, stagedProfile]);
    for (const name of LOCK_NAMES) {
      await rm(resolve(stagedProfile, name), { force: true, recursive: true });
    }
    for (const name of DISPOSABLE_PATHS) {
      await rm(resolve(stagedProfile, name), { force: true, recursive: true });
    }

    await run("tar", ["-czf", tempArchivePath, "-C", stage, "browser-worker-profile"]);
    await run("tar", ["-tzf", tempArchivePath]);
    await rename(tempArchivePath, archivePath);
    return { archivePath };
  } catch (error) {
    await rm(tempArchivePath, { force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
