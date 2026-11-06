import path from "node:path";
import { readdir, rm } from "node:fs/promises";

/**
 * Remove Chromium's atomic-write temporary files from every profile directory.
 * Chromium creates these beside databases/preferences throughout the profile,
 * not just at the profile root.
 */
export async function removeChromiumAtomicWriteFiles(profileDir) {
  let entries;
  try {
    entries = await readdir(profileDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    const entryPath = path.join(profileDir, entry.name);
    if (entry.name.startsWith(".org.chromium.")) {
      await rm(entryPath, { recursive: true, force: true });
      removed += 1;
      continue;
    }
    if (entry.isDirectory()) {
      removed += await removeChromiumAtomicWriteFiles(entryPath);
    }
  }
  return removed;
}

/** Build a clean X11 environment without inheriting an invalid runner DBus address. */
export function desktopProcessEnvironment(source, display) {
  const env = { ...source, DISPLAY: display };
  delete env.DBUS_SESSION_BUS_ADDRESS;
  delete env.DBUS_SYSTEM_BUS_ADDRESS;
  return env;
}
