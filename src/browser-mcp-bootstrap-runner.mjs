import { bootstrapBrowserMcp } from "./browser-mcp-bootstrap.mjs";

try {
  await bootstrapBrowserMcp({
    cdpPort: Number(process.env.VM_CHROMIUM_DEBUG_PORT || 9222),
    baseUrl: process.env.UTILS_BROWSER_WORKER_URL?.replace(/\/$/, ""),
    workerToken: process.env.UTILS_BROWSER_WORKER_TOKEN || "",
    workerId: process.env.VM_WORKER_ID || "browser-worker-vm",
    accessToken: process.env.BROWSER_MCP_EXTENSION_ACCESS_TOKEN || "",
    required: process.env.BROWSER_MCP_EXTENSION_REQUIRED !== "false",
  });
} catch (error) {
  console.error("BrowserMCP VM bootstrap failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
