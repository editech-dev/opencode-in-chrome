/**
 * mcp.ts — entrypoint of the oc-chrome MCP server (T12).
 *
 *   bun run …/packages/bridge/src/mcp.ts          → stdio (OpenCode spawns this)
 *   bun run …/packages/bridge/src/mcp.ts --http   → Streamable HTTP (loopback :9600)
 *
 * Kept separate from mcp/server.ts so tests can import the handler without any
 * transport side effects.
 */

import { McpBridge, serveHttp, serveStdio } from "./mcp/server"

if (process.argv.includes("--http")) {
  const idx = process.argv.indexOf("--http")
  const portArg = Number(process.argv[idx + 1])
  const server = serveHttp(new McpBridge(), Number.isFinite(portArg) && portArg > 0 ? portArg : undefined)
  process.stderr.write(`[oc-chrome-mcp] http transport on http://127.0.0.1:${server.port}/mcp\n`)
  const stop = () => server.stop(true)
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
} else {
  void serveStdio(new McpBridge())
}
