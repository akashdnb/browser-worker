# Worker runtime

The GitHub Actions worker pins the Playwright MCP runtime and uses the same `localhost:8931/mcp` endpoint for the Playwright server, readiness probe, and relay. This keeps the HTTP Host value aligned with Playwright MCP's DNS-rebinding protection.
