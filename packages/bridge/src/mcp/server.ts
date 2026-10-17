/**
 * MCP server for oc-chrome (T12) — the piece OpenCode actually talks to.
 *
 * Two transports share one JSON-RPC handler:
 *   · stdio (default): newline-delimited JSON-RPC on stdin/stdout. This is what
 *     `opencode mcp add oc-chrome -- bun run <this file>` spawns per session —
 *     one process = one sessionId = one tab group (isolation I1).
 *   · Streamable HTTP (`--http [port]`, default 9600): POST /mcp in, JSON-RPC
 *     out (application/json is a legal server choice), stateless, loopback-only,
 *     for setups that prefer one shared browser gateway.
 *
 * MCP surface (registry contract): server name IS `oc-chrome`, tool names are
 * the raw catalog names — OpenCode normalizes the tool keys to `oc_chrome_*`,
 * which is exactly what the project permission rules expect.
 *
 * stdout is protocol-only on stdio (Chrome's rule everywhere); logs → stderr.
 */

import { serve, type Server } from "bun"

type HttpServer = Server<undefined>
import { CATALOG } from "@opencode-in-chrome/core"
import { isRecord } from "@opencode-in-chrome/shared"
import { HostRelay, type ToolResult } from "./relay"

const SERVER_NAME = "oc-chrome"
const SERVER_VERSION = "0.1.0"
/** Newest protocol we can answer; we echo back whatever the client requests if it is older. */
const MAX_PROTOCOL_VERSION = "2025-06-18"

export type RpcMessage = {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export class McpBridge {
  private relay = new HostRelay()
  /**
   * Stable per process → the OpenCode session keeps its tab group across calls.
   * Public so transports and tests can inspect/pin it (OCIC_SESSION_ID wins).
   */
  readonly sessionId: string
  private protocolVersion: string | null = null

  constructor(sessionId = process.env["OCIC_SESSION_ID"] || `mcp-${Date.now().toString(36)}`) {
    this.sessionId = sessionId
  }

  liveTools(): Array<{ name: string; title: string; description: string; inputSchema: Record<string, unknown> }> {
    return CATALOG.filter((t) => t.live).map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  }

  /** Handles one JSON-RPC message; returns null for notifications. */
  async handle(msg: unknown): Promise<RpcMessage | null> {
    if (!isRecord(msg) || typeof msg !== "object") return null
    const m = msg as RpcMessage
    // Notifications carry no id — they must not be answered.
    if (m.id === undefined || m.id === null) return null
    try {
      const res = await this.dispatch(m)
      return res ?? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } }
    } catch {
      return { jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "internal error" } }
    }
  }

  private async dispatch(m: RpcMessage): Promise<unknown> {
    switch (m.method) {
      case "initialize": {
        const requested = String((m.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "")
        // A client we cannot negotiate stays a client — the newest one wins.
        this.protocolVersion = requested && requested <= MAX_PROTOCOL_VERSION ? requested : MAX_PROTOCOL_VERSION
        return {
          jsonrpc: "2.0",
          id: m.id,
          result: {
            protocolVersion: this.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        }
      }
      case "ping":
        return { jsonrpc: "2.0", id: m.id, result: {} }
      case "tools/list": {
        return { jsonrpc: "2.0", id: m.id, result: { tools: this.liveTools() } }
      }
      case "tools/call": {
        const p = m.params as { name?: string; arguments?: unknown } | undefined
        const name = typeof p?.name === "string" ? p.name : ""
        return { jsonrpc: "2.0", id: m.id, result: await this.callTool(name, p?.["arguments"]) }
      }
      default:
        // unknown method → -32601 (the .handle fallback builds it)
        return undefined
    }
  }

  private async callTool(name: string, args: unknown): Promise<ToolResult & { isError?: boolean }> {
    const known = CATALOG.find((t) => t.name === name)
    if (!known) {
      return {
        ok: false,
        isError: true,
        content: [{ type: "text", text: `unknown tool "${name}" — available: ${CATALOG.filter((t) => t.live).map((t) => t.name).join(", ")}` }],
      }
    }
    if (!isRecord(args)) {
      return { ok: false, isError: true, content: [{ type: "text", text: `${name}: arguments must be an object` }] }
    }
    try {
      const res = await this.relay.dispatch({ tool: name, args, sessionScope: { sessionId: this.sessionId } })
      if (!res.ok) {
        return {
          ok: false,
          isError: true,
          content: [{ type: "text", text: res.error?.message ?? `${name} failed` }],
        }
      }
      return { ok: true, content: res.content ?? [] }
    } catch (err) {
      return { ok: false, isError: true, content: [{ type: "text", text: `${name}: ${(err as Error).message}` }] }
    }
  }
}

// ── Transport: stdio ───────────────────────────────────────────────────────────

export async function serveStdio(mcp: McpBridge): Promise<void> {
  const { stdin, stdout } = await import("node:process")
  const log = (s: string) => {
    process.stderr.write(`[oc-chrome-mcp] ${s}\n`)
  }
  let buf = ""
  stdin.setEncoding("utf8")
  stdin.on("data", (chunk: string) => {
    buf += chunk
    for (;;) {
      const nl = buf.indexOf("\n")
      if (nl < 0) break
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      void (async () => {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
          return
        }
        const res = await mcp.handle(parsed)
        if (res) write(res)
      })()
    }
  })
  function write(res: unknown): void {
    if (stdout.destroyed) return
    stdout.write(`${JSON.stringify(res)}\n`)
  }
  stdin.on("end", () => process.exit(0))
  log(`stdio transport live (session ${mcp.sessionId})`)
}

// ── Transport: Streamable HTTP ────────────────────────────────────────────────

export function serveHttp(mcp: McpBridge, port = Number(process.env["OCIC_HTTP_PORT"] ?? 9600)): HttpServer {
  return serve({
    port,
    hostname: "127.0.0.1", // never a LAN-exposed browser gateway
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 })
      if (req.method !== "POST") {
        // GET/DELETE are the SSE/state-management sides of Streamable HTTP; we
        // serve the stateless JSON mode, so only POST exists.
        return new Response("method not allowed (stateless JSON-RPC: POST /mcp)", {
          status: 405,
          headers: { Allow: "POST" },
        })
      }
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
      }
      if (Array.isArray(body)) {
        const res = (await Promise.all(body.map((m) => mcp.handle(m)))).filter(Boolean)
        return Response.json(res)
      }
      const res = await mcp.handle(body)
      return res ? Response.json(res) : new Response(null, { status: 202 }) // notification accepted
    },
  })
}
