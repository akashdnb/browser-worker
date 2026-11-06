import path from "node:path";
import { readdir, rm } from "node:fs/promises";

/**
 * Remove Chromium's atomic-write temporary files from every profile directory.
 * Chromium creates these beside databases/preferences throughout the profile,
 * not just at the profile root. Traverse directories in bounded parallel batches
 * and remove matches concurrently so large restored profiles do not delay boot.
 */
export async function removeChromiumAtomicWriteFiles(profileDir) {
  const pendingDirectories = [profileDir];
  const staleFiles = [];
  const directoryBatchSize = 32;

  while (pendingDirectories.length) {
    const batch = pendingDirectories.splice(0, directoryBatchSize);
    const results = await Promise.all(batch.map(async (directory) => {
      try {
        return { directory, entries: await readdir(directory, { withFileTypes: true }) };
      } catch {
        return { directory, entries: [] };
      }
    }));

    for (const { directory, entries } of results) {
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.name.startsWith(".org.chromium.")) {
          staleFiles.push(entryPath);
        } else if (entry.isDirectory()) {
          pendingDirectories.push(entryPath);
        }
      }
    }
  }

  const removalBatchSize = 64;
  for (let index = 0; index < staleFiles.length; index += removalBatchSize) {
    const batch = staleFiles.slice(index, index + removalBatchSize);
    await Promise.all(batch.map((filePath) => rm(filePath, { recursive: true, force: true })));
  }
  return staleFiles.length;
}

/** Build a clean X11 environment without inheriting an invalid runner DBus address. */
export function desktopProcessEnvironment(source, display) {
  const env = { ...source, DISPLAY: display };
  delete env.DBUS_SESSION_BUS_ADDRESS;
  delete env.DBUS_SYSTEM_BUS_ADDRESS;
  return env;
}
