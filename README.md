# Browser Worker

Disposable Chromium worker for the private `akashdnb/utils` Browser MCP gateway. This repository uses Microsoft's upstream [Playwright MCP](https://github.com/microsoft/playwright-mcp) and does not copy or fork its browser automation implementation.

## How it works

- A manually dispatched GitHub Actions workflow starts a GitHub-hosted Ubuntu runner.
- Microsoft Playwright MCP runs locally with Chromium and Streamable HTTP on loopback.
- The worker opens an outbound WebSocket to `utils` and relays MCP JSON-RPC requests/responses over that connection.
- `utils` remains the only agent-facing Browser MCP endpoint. The worker has no public inbound listener.
- The job is capped below six hours. The schedule runs the worker every five hours; a new scheduled run replaces the previous run through GitHub Actions concurrency.

## Repository setup

Add these GitHub Actions repository secrets:

- `UTILS_BROWSER_WORKER_URL`: `wss://utils-l1pw.onrender.com/browser-worker`
- `UTILS_BROWSER_WORKER_TOKEN`: same value as the `RENDER_MCP_BROWSER_WORKER_TOKEN` environment variable on the `utils` Render service.

Dispatch **Browser Worker** from the Actions tab to start a worker. The scheduled workflow runs every five hours and is intended to keep a worker available. GitHub schedules can be delayed; inspect the Actions run if the worker doesn't appear.

## Security notes

This is a first usable version, not a multi-tenant browser service. The relay authenticates the worker with a shared secret and binds the connection to the private gateway. Never expose the local Playwright MCP port publicly or place the shared secret in repository files/logs. The public repo intentionally contains no credentials.
