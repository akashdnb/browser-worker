import { mkdir, writeFile, chmod } from "node:fs/promises";
import WebSocket from "ws";
import { prepareBrowserMcpExtension } from "./browser-mcp-bootstrap.mjs";

// Keep the heartbeat hook self-contained and also make the VM restore command
// resilient to Chromium's varying X11 window classes across Playwright images.
const helperDir = "/tmp/browser-worker-vm-bin";
const helperPath = `${helperDir}/xdotool`;
const realXdotool = "/usr/bin/xdotool";
const realChromium = process.env.CHROMIUM_BIN || "";
const browserMcpWrapper = `${helperDir}/chromium-browser-mcp`;
const browserMcpRunner = `${process.cwd()}/src/browser-mcp-bootstrap-runner.mjs`;
let browserMcpExtensionDir = process.env.BROWSER_MCP_EXTENSION_DIR || `${helperDir}/browser-mcp-extension`;
let browserMcpReady = false;
let browserMcpExtension = null;

try {
  await mkdir(helperDir, { recursive: true });
  await writeFile(helperPath, `#!/usr/bin/env bash
set -u
if [[ "\${1:-}" == "search" && "\${2:-}" == "--class" && "\${3:-}" == "chromium" ]]; then
  ids="$("${realXdotool}" search --class chromium 2>/dev/null || true)"
  if [[ -z "$ids" ]]; then
    for class in chrome google-chrome chromium-browser; do
      ids="$("${realXdotool}" search --class "$class" 2>/dev/null || true)"
      [[ -n "$ids" ]] && break
    done
  fi
  if [[ -z "$ids" ]]; then
    ids="$("${realXdotool}" search --name '.*Chromium.*' 2>/dev/null || true)"
  fi
  if [[ -z "$ids" ]]; then
    for pid in $(pgrep -x chrome 2>/dev/null || true) $(pgrep -x chromium 2>/dev/null || true); do
      ids="$("${realXdotool}" search --pid "$pid" 2>/dev/null || true)"
      [[ -n "$ids" ]] && break
    done
  fi
  printf '%s\\n' "$ids"
  exit 0
fi
exec "${realXdotool}" "$@"
`, { encoding: "utf8", mode: 0o755 });
  await chmod(helperPath, 0o755);
  process.env.PATH = `${helperDir}:${process.env.PATH ?? ""}`;

  if (realChromium && process.env.UTILS_BROWSER_WORKER_URL && process.env.UTILS_BROWSER_WORKER_TOKEN) {
    try {
      browserMcpExtension = await prepareBrowserMcpExtension({
        baseUrl: process.env.UTILS_BROWSER_WORKER_URL,
        workerToken: process.env.UTILS_BROWSER_WORKER_TOKEN,
        workerId: process.env.VM_WORKER_ID || "browser-worker-vm",
        extensionDir: browserMcpExtensionDir,
      });
      browserMcpExtensionDir = browserMcpExtension.extensionDir;
      process.env.BROWSER_MCP_EXTENSION_ACCESS_TOKEN = browserMcpExtension.accessToken;
      browserMcpReady = true;
      console.log(`BrowserMCP VM extension prepared at ${browserMcpExtensionDir} (version ${browserMcpExtension.extensionVersion}, authoritative ${browserMcpExtension.authoritativeVersion}, updated=${browserMcpExtension.updated})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (process.env.BROWSER_MCP_EXTENSION_REQUIRED === "true") throw error;
      console.warn(`BrowserMCP VM extension bootstrap skipped: ${message}`);
    }
  }

  if (browserMcpReady) {
    const backupDir = browserMcpExtension.backupDir || "";
    const extensionUpdated = browserMcpExtension.updated ? "1" : "0";
    await writeFile(browserMcpWrapper, `#!/usr/bin/env bash
set -u
real_bin="${realChromium}"
extension_dir="${browserMcpExtensionDir}"
runner="${browserMcpRunner}"
backup_dir="${backupDir}"
extension_updated="${extensionUpdated}"
args=("$@")
if [[ -d "$extension_dir" ]]; then
  args+=("--load-extension=$extension_dir" "--disable-extensions-except=$extension_dir")
fi

launch_chrome() {
  "$real_bin" "\${args[@]}" &
  chrome_pid=$!
}

run_bootstrap() {
  if [[ -f "$runner" && -d "$extension_dir" ]]; then
    env -u NODE_OPTIONS node "$runner"
  fi
}

finalize_update() {
  [[ "$extension_updated" == "1" ]] || return 0
  env -u NODE_OPTIONS node --input-type=module -e 'import { finalizeBrowserMcpExtensionUpdate } from "./src/browser-mcp-bootstrap.mjs"; await finalizeBrowserMcpExtensionUpdate({ extensionDir: process.env.BROWSER_MCP_EXTENSION_DIR, backupDir: process.env.BROWSER_MCP_EXTENSION_BACKUP_DIR || null });' || return 1
}

rollback_update() {
  [[ "$extension_updated" == "1" && -n "$backup_dir" ]] || return 1
  BROWSER_MCP_EXTENSION_DIR="$extension_dir" BROWSER_MCP_EXTENSION_BACKUP_DIR="$backup_dir" env -u NODE_OPTIONS node --input-type=module -e 'import { rollbackBrowserMcpExtensionUpdate } from "./src/browser-mcp-bootstrap.mjs"; await rollbackBrowserMcpExtensionUpdate({ extensionDir: process.env.BROWSER_MCP_EXTENSION_DIR, backupDir: process.env.BROWSER_MCP_EXTENSION_BACKUP_DIR });'
}

launch_chrome
bootstrap_status=0
run_bootstrap || bootstrap_status=$?
if (( bootstrap_status != 0 )); then
  echo "BrowserMCP bootstrap failed for extension ${browserMcpExtensionDir}" >&2
  kill "$chrome_pid" 2>/dev/null || true
  wait "$chrome_pid" 2>/dev/null || true
  if [[ "$extension_updated" == "1" && -n "$backup_dir" ]]; then
    echo "BrowserMCP extension update failed; restoring the previous working version" >&2
    if rollback_update; then
      extension_updated="0"
      backup_dir=""
      launch_chrome
      if run_bootstrap; then
        echo "BrowserMCP extension rollback validated successfully"
        wait "$chrome_pid"
        exit $?
      fi
      echo "BrowserMCP extension rollback validation also failed" >&2
      kill "$chrome_pid" 2>/dev/null || true
      wait "$chrome_pid" 2>/dev/null || true
    fi
  fi
  exit "$bootstrap_status"
fi

if [[ "$extension_updated" == "1" ]]; then
  BROWSER_MCP_EXTENSION_DIR="$extension_dir" BROWSER_MCP_EXTENSION_BACKUP_DIR="$backup_dir" finalize_update || {
    echo "BrowserMCP extension validated but cleanup of the previous version failed" >&2
    exit 1
  }
fi
wait "$chrome_pid"
`, { encoding: "utf8", mode: 0o755 });
    await chmod(browserMcpWrapper, 0o755);
    process.env.REAL_CHROMIUM_BIN = realChromium;
    process.env.BROWSER_MCP_BOOTSTRAP_RUNNER = browserMcpRunner;
    process.env.BROWSER_MCP_EXTENSION_DIR = browserMcpExtensionDir;
    process.env.CHROMIUM_BIN = browserMcpWrapper;
    console.log(`BrowserMCP VM wrapper enabled with extension directory ${browserMcpExtensionDir}`);
  }
} catch (error) {
  console.warn("Could not install VM browser helpers:", error instanceof Error ? error.message : String(error));
}

const originalEmit = WebSocket.prototype.emit;

WebSocket.prototype.emit = function patchedEmit(event, ...args) {
  const result = originalEmit.call(this, event, ...args);

  if (event === "open" && typeof this.url === "string" && this.url.endsWith("/vm-worker") && !this.__vmHeartbeatTimer) {
    this.__vmHeartbeatTimer = setInterval(() => {
      if (this.readyState === WebSocket.OPEN) {
        this.send(JSON.stringify({ type: "vm.heartbeat" }));
      }
    }, 15_000);
    this.__vmHeartbeatTimer.unref?.();
  }

  if (event === "close" && this.__vmHeartbeatTimer) {
    clearInterval(this.__vmHeartbeatTimer);
    this.__vmHeartbeatTimer = undefined;
  }

  return result;
};
