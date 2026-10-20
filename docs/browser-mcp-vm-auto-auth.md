# BrowserMCP VM auto-load and authentication

The interactive VM can load the Render Utils BrowserMCP Chrome extension on every Chromium start and authenticate it automatically.

## Required environment

Set these in the browser-worker GitHub Actions workflow/job:

- `BROWSER_MCP_EXTENSION_DIR` — absolute path to a checked-out copy of `utils/browser_extension`.
- `BROWSER_MCP_EXTENSION_REQUIRED=true` — fail the VM startup if the extension cannot be loaded or authenticated.
- Either:
  - `BROWSER_MCP_EXTENSION_ACCESS_TOKEN` — an already-issued Browser MCP OAuth access token, or
  - `BROWSER_MCP_OAUTH_USERNAME` and `BROWSER_MCP_OAUTH_PASSWORD` — the Render Utils OAuth credentials. The bootstrap script performs the authorization-code + PKCE flow itself and never logs the credentials or access token.

The extension access token is written into the VM Chromium profile with CDP. The existing persistent profile artifact therefore keeps the authenticated extension state between workflow runs, while the startup bootstrap can refresh it when credentials are configured.

## Startup flow

1. The existing VM heartbeat preload runs before `src/vm.js` reads `CHROMIUM_BIN`.
2. When `BROWSER_MCP_EXTENSION_DIR` is configured, it replaces `CHROMIUM_BIN` with a small Chromium wrapper.
3. The wrapper starts Chromium with `--load-extension=<extension-dir>`.
4. The wrapper waits for the extension service worker to appear on CDP.
5. `src/browser-mcp-bootstrap.mjs` discovers the extension ID from the service-worker URL.
6. If an access token was not supplied directly, it registers a public OAuth client using the extension callback URI, completes the Render Utils authorization form with the configured VM OAuth credentials, exchanges the PKCE authorization code, and obtains a Browser MCP access token.
7. The token and trusted bridge URL are written to `chrome.storage.local` in the extension context.
8. The extension's existing storage-change listener reconnects its WebSocket to the BrowserMCP gateway automatically.

## Security

Do not commit OAuth credentials or access tokens. Keep them as GitHub Actions secrets. The access token is also sensitive; the bootstrap code intentionally avoids logging it.

The browser extension itself is still the same `utils/browser_extension` implementation used by the real Chrome browser; this change only automates VM installation/loading and authentication.
