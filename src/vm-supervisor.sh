#!/usr/bin/env bash
set -u

# BrowserMCP VM extension bootstrap is intentionally disabled. The VM browser
# is controlled through the existing Playwright/CDP path instead. Keep the
# wrapper implementation in the repository for possible future use.

backoff=2
max_backoff=30

cleanup_display() {
  local display="${DISPLAY:-:99}"
  local display_num="${display#:}"

  # vm.js owns these desktop processes. Clean them before every retry so a
  # failed startup cannot leave an X server or desktop helper behind.
  pkill -TERM -f "^Xvfb ${display}" 2>/dev/null || true
  pkill -TERM -f "^x11vnc .*${display}" 2>/dev/null || true
  pkill -TERM -f "^openbox .*${display}" 2>/dev/null || true

  for _ in $(seq 1 20); do
    if ! pgrep -f "^Xvfb ${display}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done

  if pgrep -f "^Xvfb ${display}" >/dev/null 2>&1; then
    pkill -KILL -f "^Xvfb ${display}" 2>/dev/null || true
  fi

  # Only remove the display lock/socket after no Xvfb owns the display.
  if ! pgrep -f "^Xvfb ${display}" >/dev/null 2>&1; then
    rm -f "/tmp/.X${display_num}-lock" "/tmp/.X11-unix/X${display_num}"
  fi
}

trap cleanup_display EXIT INT TERM

while true; do
  cleanup_display
  echo "Starting interactive VM relay (backoff=${backoff}s)"
  node src/cdp-watchdog.mjs &
  watchdog_pid=$!

  node src/vm.js
  exit_code=$?

  kill "${watchdog_pid}" 2>/dev/null || true
  wait "${watchdog_pid}" 2>/dev/null || true
  cleanup_display

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
