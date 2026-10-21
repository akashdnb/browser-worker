import { mkdir, copyFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createProfileCheckpoint, profileIsReady } from "./profile-checkpoint.mjs";

const profileDir = process.env.PLAYWRIGHT_MCP_USER_DATA_DIR ?? process.env.BROWSER_WORKER_PROFILE_DIR;
const artifactDir = process.env.BROWSER_WORKER_CHECKPOINT_DIR;
const checkpointSeconds = Number.parseInt(process.env.BROWSER_WORKER_CHECKPOINT_SECONDS ?? "60", 10);

if (!profileDir || !artifactDir) {
  throw new Error("PLAYWRIGHT_MCP_USER_DATA_DIR and BROWSER_WORKER_CHECKPOINT_DIR are required");
}
if (!Number.isInteger(checkpointSeconds) || checkpointSeconds < 15 || checkpointSeconds > 600) {
  throw new Error("BROWSER_WORKER_CHECKPOINT_SECONDS must be between 15 and 600");
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
timer.unref?.();

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
