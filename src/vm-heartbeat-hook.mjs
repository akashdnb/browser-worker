import { mkdir, writeFile, chmod } from "node:fs/promises";
import WebSocket from "ws";

// Keep the heartbeat hook self-contained and also make the VM restore command
// resilient to Chromium's varying X11 window classes across Playwright images.
const helperDir = "/tmp/browser-worker-vm-bin";
const helperPath = `${helperDir}/xdotool`;
const realXdotool = "/usr/bin/xdotool";
const browserMcpExtensionDir = process.env.BROWSER_MCP_EXTENSION_DIR || "";
const realChromium = process.env.CHROMIUM_BIN || "";
const browserMcpWrapper = `${helperDir}/chromium-browser-mcp`;
const browserMcpRunner = `${process.cwd()}/src/browser-mcp-bootstrap-runner.mjs`;

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

  if (browserMcpExtensionDir && realChromium) {
    await writeFile(browserMcpWrapper, `#!/usr/bin/env bash
set -u
real_bin="${realChromium}"
extension_dir="${browserMcpExtensionDir}"
runner="${browserMcpRunner}"
args=("$@")
if [[ -d "$extension_dir" ]]; then args+=("--load-extension=$extension_dir"); fi
"$real_bin" "${args[@]}" &
chrome_pid=$!
bootstrap_status=0
if [[ -f "$runner" && -d "$extension_dir" ]]; then node "$runner" || bootstrap_status=$?; fi
if (( bootstrap_status != 0 )); then
  echo "BrowserMCP bootstrap failed; stopping Chromium" >&2
  kill "$chrome_pid" 2>/dev/null || true
  wait "$chrome_pid" 2>/dev/null || true
  exit "$bootstrap_status"
fi
wait "$chrome_pid"
`, { encoding: "utf8", mode: 0o755 });
    await chmod(browserMcpWrapper, 0o755);
    process.env.REAL_CHROMIUM_BIN = realChromium;
    process.env.BROWSER_MCP_BOOTSTRAP_RUNNER = browserMcpRunner;
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
