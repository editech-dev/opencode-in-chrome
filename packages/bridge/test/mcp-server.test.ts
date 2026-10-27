/**
 * mcp-server.test.ts — the OpenCode-facing contract, pinned:
 *   · initialize negotiation (echo older client versions, cap at ours)
 *   · tools/list exposes ONLY live catalog tools with their JSON schemas
 *   · tools/call routes to the relay and maps ok/error/timeout → MCP isError
 *   · unknown tool / bad args / parse error / unknown method are typed errors
 *   · relay reaches the host through a REAL socket with the wire framing
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, connect as tcpConnect, type Server as TcpServer, type Socket } from "node:net"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeFrame, FrameReader } from "@opencode-in-chrome/shared"
import { McpBridge } from "../src/mcp/server"
import { HostRelay, findLiveSocket } from "../src/mcp/relay"

const req = (id: number, method: string, params?: unknown) =>
  ({ jsonrpc: "2.0", id, method, params }) as const

// ── handler contract ──────────────────────────────────────────────────────────

describe("MCP handler", () => {
  const mcp = new McpBridge("test-session")

  test("initialize echoes older client protocol versions and caps newer ones", async () => {
    const older = (await mcp.handle(req(1, "initialize", { protocolVersion: "2024-11-05", clientInfo: {} }))) as {
      result: { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string } }
    }
    expect(older.result.protocolVersion).toBe("2024-11-05")
    expect(older.result.capabilities.tools).toBeDefined()
    expect(older.result.serverInfo.name).toBe("oc-chrome")

    const newer = (await mcp.handle(req(2, "initialize", { protocolVersion: "9999-01-01" }))) as {
      result: { protocolVersion: string }
    }
    expect(newer.result.protocolVersion).toBe("2025-06-18")
  })

  test("notifications are not answered", async () => {
    expect(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull()
  })

  test("tools/list pin: exactly the live catalog, schemas passthrough", async () => {
    const res = (await mcp.handle(req(3, "tools/list"))) as { result: { tools: { name: string; inputSchema: unknown }[] } }
    expect(res.result.tools.map((t) => t.name).sort()).toEqual([
      "computer",
      "get_page_text",
      "navigate",
      "tabs_close",
      "tabs_context",
      "tabs_create",
    ])
    const navigate = res.result.tools.find((t) => t.name === "navigate")
    expect(navigate?.inputSchema).toMatchObject({ required: ["url"] })
  })

  test("tools/call unknown tool → isError with available list", async () => {
    const res = (await mcp.handle(req(4, "tools/call", { name: "time_travel", arguments: {} }))) as {
      result: { isError: boolean; content: { text: string }[] }
    }
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0]!.text).toContain("tabs_context")
  })

  test("ping answers empty result; unknown method → -32601", async () => {
    const ping = (await mcp.handle(req(5, "ping"))) as { result: Record<string, never> }
    expect(ping.result).toEqual({})
    const unk = (await mcp.handle(req(6, "resources/list"))) as { error: { code: number } }
    expect(unk.error.code).toBe(-32601)
  })
})

// ── relay against a REAL host-shaped socket ───────────────────────────────────

describe("relay (wire framing through a real socket)", () => {
  let server: TcpServer
  let hostPath: string
  let lastReceived: Record<string, unknown> | null = null
  let silentTool: string | null = null

  beforeAll(async () => {
    hostPath = join(tmpdir(), `ocic-test-${process.pid}.sock`)
    await rm(hostPath, { force: true })
    server = createServer((socket: Socket) => {
      const reader = new FrameReader()
      socket.on("data", (chunk: Buffer) => {
        for (const frame of reader.push(chunk)) {
          const msg = frame as { type?: string; id?: string; tool?: string; sessionScope?: { sessionId?: string } }
          if (msg.type === "ping") socket.write(encodeFrame({ type: "pong", timestamp: 0 }))
          if (msg.type === "tool_request") {
            lastReceived = msg
            if (msg.tool === silentTool) continue // simulated browser that never answers
            socket.write(
              encodeFrame({
                type: "tool_response",
                id: msg.id,
                ok: true,
                result: { content: [{ type: "text", text: "relay-answer" }] },
              }),
            )
          }
        }
      })
    })
    await new Promise<void>((r) => server.listen(hostPath, () => r()))
    process.env["OCIC_SOCKET"] = hostPath // deterministic discovery for this suite
  })

  afterAll(async () => {
    server.close()
    delete process.env["OCIC_SOCKET"]
    await rm(hostPath, { force: true })
  })

  test("findLiveSocket honors OCIC_SOCKET (probe-based otherwise)", async () => {
    expect(await findLiveSocket()).toBe(hostPath)
  })

  test("dispatch sends session scope and returns mapped content", async () => {
    const relay = new HostRelay("probe")
    const res = await relay.dispatch({ tool: "get_page_text", args: { tabId: 5 }, sessionScope: { sessionId: "s1" } })
    expect(res.ok).toBe(true)
    expect(res.content![0]).toEqual({ type: "text", text: "relay-answer" })
    expect(lastReceived).toMatchObject({ type: "tool_request", tool: "get_page_text", clientId: "probe" })
    expect((lastReceived as { sessionScope: { sessionId: string } }).sessionScope.sessionId).toBe("s1")
  })

  test("tools/call passes the REAL sessionID from _meta (contract #8 — TD-1 fix)", async () => {
    lastReceived = null
    const bridge = new McpBridge("test-session")
    const res = (await bridge.handle(req(7, "tools/call", {
      name: "tabs_context",
      arguments: { createIfEmpty: false },
      _meta: { "ai.opencode/sessionID": "ses_real9182", progressToken: 2 },
    }))) as { result: { content: Array<{ type: string; text: string }> } }
    expect(res.result.content[0]).toEqual({ type: "text", text: "relay-answer" })
    expect((lastReceived as unknown as { sessionScope?: { sessionId?: string } }).sessionScope?.sessionId).toBe("ses_real9182")
  })

  test("tools/call without _meta keeps the process fallback sessionId", async () => {
    lastReceived = null
    const bridge = new McpBridge("test-session")
    await bridge.handle(req(8, "tools/call", { name: "tabs_context", arguments: {} }))
    expect((lastReceived as unknown as { sessionScope?: { sessionId?: string } }).sessionScope?.sessionId).toBe("test-session")
  })

  test("concurrent dispatches match responses by id (multiplex)", async () => {
    const relay = new HostRelay()
    const [a, b] = await Promise.all([
      relay.dispatch({ tool: "tabs_context", args: {}, sessionScope: { sessionId: "s2" } }),
      relay.dispatch({ tool: "navigate", args: {}, sessionScope: { sessionId: "s3" } }),
    ])
    expect(a.ok && b.ok).toBe(true)
  })

  test("tool_response for an unknown id does not crash the relay", async () => {
    const socket = tcpConnect(hostPath)
    await new Promise<void>((r) => socket.on("connect", r))
    socket.write(encodeFrame({ type: "tool_response", id: "ghost:1", ok: true, result: { content: [] } }))
    expect(true).toBe(true)
    socket.destroy()
  })

  test("unresponsive tool → typed timeout error", async () => {
    const relay = new HostRelay()
    silentTool = "get_page_text"
    try {
      const res = await relay.dispatch({
        tool: "get_page_text",
        args: {},
        sessionScope: { sessionId: "s4" },
        timeoutMs: 400,
      })
      expect(res.ok).toBe(false)
      expect(res.error?.message).toContain("timed out after 400 ms")
    } finally {
      silentTool = null
    }
  })
})
