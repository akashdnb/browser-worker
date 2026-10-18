# Browser Worker

Disposable Chromium worker for the private `akashdnb/utils` Browser MCP gateway. This repository uses Microsoft's upstream [Playwright MCP](https://github.com/microsoft/playwright-mcp) and does not copy or fork its browser automation implementation.

## How it works

- A manually dispatched GitHub Actions workflow starts a GitHub-hosted Ubuntu runner.
- Microsoft Playwright MCP runs locally with Chromium and Streamable HTTP on loopback.
- The worker opens an outbound WebSocket to `utils` and relays MCP JSON-RPC requests/responses over that connection.
- `utils` remains the only agent-facing Browser MCP endpoint. The worker has no public inbound listener.
- The job is capped below six hours. A six-hour scheduled run is only a safety net; the worker normally renews itself 15 minutes before its limit, passing the current run ID so its latest Chromium profile is restored.
- Delayed schedule/push starts are skipped if a worker is already active, preventing an older successful profile artifact from overwriting the live profile.
- Chromium is launched with an explicit `--user-data-dir=<path>` and the worker verifies that `Local State` and `Default/Preferences` are written there before announcing readiness. Profile restore/archive steps reject empty snapshots instead of silently replacing browser state with a fresh profile. The worker uses `--restore-last-session` without an explicit startup URL so Chromium can reopen saved tabs from its session files.

## Repository setup

Add these GitHub Actions repository secrets:

- `UTILS_BROWSER_WORKER_URL`: `wss://utils-l1pw.onrender.com/browser-worker`
- `UTILS_BROWSER_WORKER_TOKEN`: same value as the `RENDER_MCP_BROWSER_WORKER_TOKEN` environment variable on the `utils` Render service.

Dispatch **Browser Worker** from the Actions tab to start a worker when none is active. Use **Restart Browser Worker** for an intentional manual restart; it archives the active profile first. If multiple workers overlap, it refuses to guess which profile is current. GitHub schedules can be delayed; an overlapping safety-net run is skipped rather than replacing the active session.

## Security notes

This is a first usable version, not a multi-tenant browser service. The relay authenticates the worker with a shared secret and binds the connection to the private gateway. Never expose the local Playwright MCP port publicly or place the shared secret in repository files/logs. The public repo intentionally contains no credentials.
