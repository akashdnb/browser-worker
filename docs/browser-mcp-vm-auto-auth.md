# BrowserMCP VM auto-load and authentication

The interactive VM now loads the same Render Utils BrowserMCP Chrome extension on every Chromium start and authenticates it automatically.

## Required environment

No new secret is required. The existing VM environment already provides:

- `UTILS_BROWSER_WORKER_URL`
- `UTILS_BROWSER_WORKER_TOKEN`
- `VM_WORKER_ID`
- `VM_CHROMIUM_DEBUG_PORT`

`BROWSER_MCP_EXTENSION_REQUIRED=true` can be set if the VM should fail rather than continue without the extension when bootstrap fails.

## Startup flow

1. The existing VM heartbeat preload runs before `src/vm.js` reads `CHROMIUM_BIN`.
2. It calls the utils Browser MCP token endpoint using the existing worker bearer token.
3. The authenticated response contains both a fresh Browser MCP access token and a compressed copy of `utils/browser_extension`.
4. The preload extracts the extension into the VM's temporary helper directory.
5. Chromium is launched with `--load-extension=<extension-dir>`.
6. The bootstrap waits for the extension service worker to appear on CDP and discovers its extension ID.
7. The access token and trusted bridge URL are written to `chrome.storage.local` inside the extension context.
8. The extension's existing storage-change listener reconnects its WebSocket to the BrowserMCP gateway automatically.

This means a fresh VM does not need a GitHub checkout token, manual `chrome://extensions` interaction, or manually entered OAuth credentials.

## Persistence

The extension source is refreshed on every VM startup. The authenticated token is also written to the persistent Chromium profile, so normal browser-worker profile archival continues to preserve extension state. A fresh bootstrap token is minted on startup, so an old expired Browser MCP token does not block reconnects.

## Security

The VM bootstrap grant is accepted only with the existing `UTILS_BROWSER_WORKER_TOKEN`. The response is `Cache-Control: no-store`, and the worker token and Browser MCP access token are never logged by the bootstrap code.

The browser extension itself is still the same `utils/browser_extension` implementation used by the real Chrome browser; this change only automates VM installation/loading and authentication.
