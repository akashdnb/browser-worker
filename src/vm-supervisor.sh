#!/usr/bin/env bash
set -u

# BrowserMCP VM extension bootstrap is intentionally disabled. The VM browser
# is controlled through the existing Playwright/CDP path instead. Keep the
# wrapper implementation in the repository for possible future use.

backoff=2
max_backoff=30

while true; do
  echo "Starting interactive VM relay (backoff=${backoff}s)"
  node src/vm.js
  exit_code=$?

  if [ "${exit_code}" -eq 0 ]; then
    echo "Interactive VM relay exited normally; restarting in ${backoff}s"
  else
    echo "Interactive VM relay exited with code ${exit_code}; restarting in ${backoff}s"
  fi

  sleep "${backoff}s"
  if [ "${backoff}" -lt "${max_backoff}" ]; then
    backoff=$((backoff * 2))
    if [ "${backoff}" -gt "${max_backoff}" ]; then
      backoff="${max_backoff}"
    fi
  fi
done
