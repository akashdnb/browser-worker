import { mkdir, copyFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { createProfileCheckpoint, profileIsReady } from "./profile-checkpoint.mjs";
import { encryptFile, profileEncryptionSecrets } from "./profile-archive-crypto.mjs";

const profileDir = process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? process.env.BROWSER_WORKER_PROFILE_DIR;
const artifactDir = process.env.BROWSER_WORKER_CHECKPOINT_DIR;
const checkpointSeconds = Number.parseInt(process.env.BROWSER_WORKER_CHECKPOINT_SECONDS ?? "60", 10);
const uploadSeconds = Number.parseInt(process.env.BROWSER_WORKER_CHECKPOINT_UPLOAD_SECONDS ?? "900", 10);
const shouldUpload = process.env.GITHUB_ACTIONS === "true";
if (shouldUpload && !process.env.GH_TOKEN) {
  throw new Error("GH_TOKEN is required to upload encrypted browser profile checkpoints");
}
const releaseTag = "browser-worker-state";
let releaseReady = false;
let lastUploadedAt = 0;

if (!profileDir || !artifactDir) {
  throw new Error("PLAYWRIGHT_MCP_USER_DATA_DIR and BROWSER_WORKER_CHECKPOINT_DIR are required");
}
if (!Number.isInteger(checkpointSeconds) || checkpointSeconds < 15 || checkpointSeconds > 600) {
  throw new Error("BROWSER_WORKER_CHECKPOINT_SECONDS must be between 15 and 600");
}
if (!Number.isInteger(uploadSeconds) || uploadSeconds < 60 || uploadSeconds > 3600) {
  throw new Error("BROWSER_WORKER_CHECKPOINT_UPLOAD_SECONDS must be between 60 and 3600");
}

function run(command, args, { captureStdout = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (captureStdout) child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} exited with code=${code}, signal=${signal}: ${stderr.slice(-2000)}`));
    });
  });
}

async function ensureRelease() {
  if (releaseReady) return;
  try {
    await run("gh", ["release", "view", releaseTag]);
  } catch {
    try {
      await run("gh", [
        "release", "create", releaseTag,
        "--draft",
        "--title", "Encrypted Browser Worker State",
        "--notes", "Private draft release containing encrypted browser profile recovery assets.",
      ]);
    } catch {
      // A concurrent startup may have created the release between view/create.
      await run("gh", ["release", "view", releaseTag]);
    }
  }
  releaseReady = true;
}

async function pruneReleaseAssets(prefix, keep = 3) {
  const output = await run("gh", [
    "release", "view", releaseTag, "--json", "assets", "--jq", ".assets[].name",
  ], { captureStdout: true });
  const names = output.split(/\r?\n/).filter((name) => name.startsWith(`${prefix}-`)).sort().reverse();
  for (const name of names.slice(keep)) {
    try {
      await run("gh", ["release", "delete-asset", releaseTag, name, "--yes"]);
    } catch (error) {
      console.warn("Could not prune old encrypted profile asset:", error instanceof Error ? error.message : String(error));
    }
  }
}

async function uploadEncryptedAsset(filePath, prefix, suffix) {
  await ensureRelease();
  const assetName = `${prefix}-${Date.now()}${suffix}`;
  const assetPath = path.join(artifactDir, assetName);
  await copyFile(filePath, assetPath);
  try {
    await run("gh", ["release", "upload", releaseTag, assetPath]);
  } finally {
    await rm(assetPath, { force: true });
  }
  try {
    await pruneReleaseAssets(prefix);
  } catch (error) {
    console.warn("Could not prune older encrypted profile assets:", error instanceof Error ? error.message : String(error));
  }
  return assetName;
}

let stopping = false;
let checkpointPromise = null;
let timer;

async function publishCheckpoint() {
  if (checkpointPromise) return checkpointPromise;

  checkpointPromise = (async () => {
    if (!(await profileIsReady(profileDir))) {
      console.warn("Skipping browser profile checkpoint: Chromium profile metadata is not ready");
      return;
    }
    const { archivePath } = await createProfileCheckpoint({
      profileDir,
      outputDir: artifactDir,
    });
    const markerPath = path.join(artifactDir, "checkpoint.json");
    const markerTemp = `${markerPath}.${process.pid}.tmp`;
    const details = {
      version: 1,
      savedAt: new Date().toISOString(),
      archive: path.basename(archivePath),
      bytes: (await stat(archivePath)).size,
    };
    const readyPath = path.join(artifactDir, `browser-worker-profile.${process.pid}.ready.tmp`);
    await copyFile(archivePath, readyPath);
    await rename(readyPath, path.join(artifactDir, "browser-worker-profile.tar.gz"));
    await writeFile(markerTemp, JSON.stringify(details, null, 2));
    await rename(markerTemp, markerPath);
    console.log(`Chromium profile checkpoint saved at ${details.savedAt} (${details.bytes} bytes)`);

    if (shouldUpload && (lastUploadedAt === 0 || Date.now() - lastUploadedAt >= uploadSeconds * 1000)) {
      const secrets = profileEncryptionSecrets();
      if (!secrets.length) throw new Error("Browser profile encryption key is not configured");
      const encryptedArchivePath = `${archivePath}.enc`;
      await encryptFile(archivePath, encryptedArchivePath, secrets[0]);
      const artifactName = `browser-worker-profile-checkpoint-${Date.now()}`;
      await uploadEncryptedAsset(encryptedArchivePath, "browser-worker-profile", ".tar.gz.enc");
      const storageStatePath = process.env.BROWSER_WORKER_STATE_FILE;
      if (storageStatePath) {
        try {
          await stat(storageStatePath);
          const encryptedStorageStatePath = `${storageStatePath}.enc`;
          await encryptFile(storageStatePath, encryptedStorageStatePath, secrets[0]);
          await uploadEncryptedAsset(encryptedStorageStatePath, "storage-state", ".json.enc");
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      lastUploadedAt = Date.now();
      console.log(`Uploaded durable encrypted Chromium checkpoint ${artifactName} to the private draft release`);
    }
  })();

  try {
    await checkpointPromise;
  } catch (error) {
    console.error("Chromium profile checkpoint failed:", error instanceof Error ? error.message : String(error));
  } finally {
    checkpointPromise = null;
  }
}

await mkdir(artifactDir, { recursive: true });
await publishCheckpoint();
timer = setInterval(() => {
  if (!stopping) void publishCheckpoint();
}, checkpointSeconds * 1000);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  if (checkpointPromise) await checkpointPromise;
  else await publishCheckpoint();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
