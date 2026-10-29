#!/usr/bin/env bash
set -u

# BrowserMCP VM extension bootstrap runs as a Node preload before vm.js so
# Chromium starts with the authoritative extension and authenticates it.

backoff=2
max_backoff=30

cleanup_display() {
  local display="${DISPLAY:-:99}"
  local display_num="${display#:}"

  # vm.js owns these desktop processes. Match their command lines by display
  # so a failed startup cannot leave an X server or desktop helper behind.
  pkill -TERM -f "Xvfb.*${display}" 2>/dev/null || true
  pkill -TERM -f "x11vnc.*${display}" 2>/dev/null || true
  pkill -TERM -f "openbox.*${display}" 2>/dev/null || true

  for _ in $(seq 1 20); do
    if ! pgrep -af "Xvfb.*${display}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done

  if pgrep -af "Xvfb.*${display}" >/dev/null 2>&1; then
    pkill -KILL -f "Xvfb.*${display}" 2>/dev/null || true
  fi

  # Only remove the display lock/socket after no Xvfb owns the display.
  if ! pgrep -af "Xvfb.*${display}" >/dev/null 2>&1; then
    rm -f "/tmp/.X${display_num}-lock" "/tmp/.X11-unix/X${display_num}"
  fi
}

stop_helper() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

hard_recovery() {
  echo "Applying hard VM recovery: terminating stale Chromium and desktop state"
  pkill -TERM -f '[c]hromium.*remote-debugging-port' 2>/dev/null || true
  sleep 1
  pkill -KILL -f '[c]hromium.*remote-debugging-port' 2>/dev/null || true
  cleanup_display

  # These locks can survive an abrupt runner/process termination. They are
  # safe to remove only after Chromium has been terminated.
  if [ -n "${PLAYWRIGHT_MCP_USER_DATA_DIR:-}" ]; then
    rm -f \
      "${PLAYWRIGHT_MCP_USER_DATA_DIR}/SingletonLock" \
      "${PLAYWRIGHT_MCP_USER_DATA_DIR}/SingletonCookie" \
      "${PLAYWRIGHT_MCP_USER_DATA_DIR}/SingletonSocket" \
      "${PLAYWRIGHT_MCP_USER_DATA_DIR}/DevToolsActivePort"
  fi
}

trap cleanup_display EXIT INT TERM

consecutive_failures=0
while true; do
  cleanup_display

  # After repeated startup/runtime failures, escalate from normal cleanup to
  # a full browser/profile/display reset. This lets the same runner recover
  # from poisoned Chromium state without requiring a new workflow run.
  if [ "$consecutive_failures" -ge 3 ]; then
    hard_recovery
    consecutive_failures=0
  fi

  echo "Starting interactive VM relay (backoff=${backoff}s)"
  node src/cdp-watchdog.mjs &
  watchdog_pid=$!
  node src/chrome-tab-guard.mjs &
  tab_guard_pid=$!

  node --import ./src/vm-heartbeat-hook.mjs src/vm.js
  exit_code=$?

  stop_helper "$watchdog_pid"
  stop_helper "$tab_guard_pid"
  cleanup_display
  consecutive_failures=$((consecutive_failures + 1))

  if [ "${exit_code}" -eq 0 ]; then
    echo "Interactive VM relay exited normally; restarting in ${backoff}s"
  else
    echo "Interactive VM relay exited with code ${exit_code}; restarting in ${backoff}s"
  fi

  sleep "${backoff}"
  if [ "${backoff}" -lt "${max_backoff}" ]; then
    backoff=$((backoff * 2))
    if [ "${backoff}" -gt "${max_backoff}" ]; then
      backoff="${max_backoff}"
    fi
  fi
done
