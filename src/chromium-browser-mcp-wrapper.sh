#!/usr/bin/env bash
set -u

real_bin="${REAL_CHROMIUM_BIN:?REAL_CHROMIUM_BIN is required}"
extension_dir="${BROWSER_MCP_EXTENSION_DIR:-}"
runner="${BROWSER_MCP_BOOTSTRAP_RUNNER:-}"

args=("$@")
if [[ -n "$extension_dir" && -d "$extension_dir" ]]; then
  args+=("--load-extension=$extension_dir")
fi

"$real_bin" "${args[@]}" &
chrome_pid=$!

bootstrap_status=0
if [[ -n "$runner" && -f "$runner" && -n "$extension_dir" && -d "$extension_dir" ]]; then
  node "$runner" || bootstrap_status=$?
fi

if (( bootstrap_status != 0 )); then
  echo "BrowserMCP bootstrap failed; stopping Chromium" >&2
  kill "$chrome_pid" 2>/dev/null || true
  wait "$chrome_pid" 2>/dev/null || true
  exit "$bootstrap_status"
fi

wait "$chrome_pid"
