/**
 * relay.ts — the socket client every MCP transport shares.
 *
 * The MCP server (spawned by OpenCode) never talks to the extension directly;
 * it connects to the native host's local socket (`bridge-<hostpid>.sock`) and
 * speaks the 4B-LE+JSON wire protocol: tool_request in, tool_response out,
 * correlated by id, with session scope for tab-group isolation (I1).
 *
 * Discovery mirrors the e2e harness: OCIC_SOCKET wins, then the newest live
 * socket in the platform bridge dir. Connections are lazy and recreated on
 * failure so a Chrome restart never requires killing the MCP server.
 */

import { connect, type Socket } from "node:net"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { bridgeDir, currentPlatform, encodeFrame, FrameReader, isRecord } from "@opencode-in-chrome/shared"

/** Timeouts from specs/04 (contrato común) — ms per tool family. */
const TIMEOUT_MS: Record<string, number> = {
  navigate: 15_000,
  computer: 10_000,
  javascript_tool: 15_000,
  form_input: 10_000,
}
const DEFAULT_TIMEOUT_MS = 7_000

export type ToolResult = {
  ok: boolean
  content?: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
  error?: { message: string }
}

/** Finds the newest live host socket path (or fails with honest guidance). */
export async function findLiveSocket(): Promise<string> {
  if (process.env["OCIC_SOCKET"]) return process.env["OCIC_SOCKET"]
  if (currentPlatform() === "win32") {
    throw new Error("no OCIC_SOCKET and Windows pipes cannot be enumerated — set OCIC_SOCKET to \\\\.\\pipe\\oc-chrome-bridge-...")
  }
  const dir = bridgeDir()
  const entries = await readdir(dir).catch(() => [])
  const sockets = entries.filter((n) => /^bridge-\d+\.sock$/.test(n))
  for (const name of [...sockets].reverse()) {
    const path = join(dir, name)
    if (await probeSocket(path)) return path
  }
  throw new Error(
    `no live bridge socket in ${dir} — open Chrome with the opencode-in-chrome extension (it spawns the host)`,
  )
}

function probeSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect(path, () => c.write(encodeFrame({ type: "ping" })))
    c.setTimeout(1_500)
    c.on("data", () => {
      c.destroy()
      resolve(true)
    })
    c.on("timeout", () => {
      c.destroy()
      resolve(false)
    })
    c.on("error", () => resolve(false))
  })
}

export type DispatchOptions = {
  tool: string
  args: unknown
  sessionScope: { sessionId: string; tabGroupId?: number }
  /** Strictly internal override (tests); production code uses the catalog table. */
  timeoutMs?: number
}

/**
 * One relay per MCP server process; safe to share across concurrent requests —
 * responses are matched by correlation id, never by arrival order.
 */
export class HostRelay {
  private socket: Socket | null = null
  private reader = new FrameReader()
  private pending = new Map<string, { resolve: (r: ToolResult) => void; timer: ReturnType<typeof setTimeout> }>()
  private seq = 0

  constructor(private readonly clientId = "mcp") {}

  /** Sends a tool_request and waits for the matching tool_response. */
  async dispatch({ tool, args, sessionScope, timeoutMs }: DispatchOptions): Promise<ToolResult> {
    const socket = await this.ensureSocket().catch((err: Error) => {
      throw new Error(err.message) // discovery failure → typed MCP error upstream
    })
    const id = `mcp-${++this.seq}-${Date.now().toString(36)}`
    const limit = timeoutMs ?? (TIMEOUT_MS[tool] ?? DEFAULT_TIMEOUT_MS)
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({
          ok: false,
          error: {
            message: `${tool}: timed out after ${limit} ms waiting for the browser (the tool may still have landed — re-check with a read-only tool)`,
          },
        })
      }, limit)
      this.pending.set(id, { resolve, timer })
      socket.write(encodeFrame({ type: "tool_request", id, tool, args, clientId: this.clientId, sessionScope }))
    })
  }

  private async ensureSocket(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket
    this.socket = null
    const path = await findLiveSocket()
    return new Promise((resolve, reject) => {
      const socket = connect(path)
      socket.setTimeout(5_000)
      socket.once("connect", () => {
        socket.setTimeout(0)
        socket.setNoDelay(true)
        this.socket = socket
        this.reader = new FrameReader()
        socket.on("data", (chunk: Buffer) => this.onData(chunk))
        socket.on("error", () => this.dropSocket())
        socket.on("close", () => this.dropSocket())
        resolve(socket)
      })
      socket.once("timeout", () => {
        socket.destroy()
        reject(new Error(`timed out connecting to bridge socket ${path}`))
      })
      socket.once("error", (err) => reject(new Error(`bridge socket ${path}: ${err.message}`)))
    })
  }

  private onData(chunk: Buffer): void {
    let frames: unknown[]
    try {
      frames = this.reader.push(chunk)
    } catch {
      this.dropSocket()
      return
    }
    for (const frame of frames) {
      if (!isRecord(frame)) continue
      const id = frame["id"]
      if (typeof id === "string" && this.pending.has(id)) {
        const { resolve, timer } = this.pending.get(id)!
        this.pending.delete(id)
        clearTimeout(timer)
        resolve({
          ok: frame["ok"] === true,
          content: (frame as { result?: { content?: ToolResult["content"] } }).result?.content ?? [],
          error: (frame as { error?: { message: string } }).error,
        })
      }
      // Notifications (keepalive/task_completed) are deliberately ignored here —
      // MCP logging surfaces come later (Fase 3 routes them to the panel).
    }
  }

  private dropSocket(): void {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer)
      resolve({ ok: false, error: { message: "bridge socket closed while the call was in flight — retry the tool" } })
    }
    this.pending.clear()
  }
}
