/**
 * oc-chrome native messaging host (ADR 002: Node-compatible core, Bun-first).
 *
 * Spawned BY Chrome when the extension calls `runtime.connectNative()`. It:
 *   1. speaks the 4B-LE+JSON protocol with Chrome over stdin/stdout (stdout is
 *      protocol-only — all logging goes to stderr, or Chrome kills the pipe);
 *   2. listens on a local socket (unix) / named pipe (Windows) named after its
 *      own pid, so MCP server processes (spawned by OpenCode) can connect;
 *   3. relays tool_request (socket → Chrome) and tool_response (Chrome → socket)
 *      matched by correlation id, multiplexing N clients over one extension.
 *
 * Windows lessons baked in: sanitized pipe name, single stdio reader, logs on
 * stderr only, O_BINARY is a wrapper-script concern (see infra/installer).
 */

import { createServer, connect, type Server, type Socket } from "node:net"
import { appendFile, chmod, mkdir, readdir, rm } from "node:fs/promises"
import { stdin, stdout, pid } from "node:process"
import {
  FrameReader,
  encodeFrame,
  HOST_NAME,
  PROTOCOL_VERSION,
  bridgeDir,
  currentPlatform,
  socketPathForPid,
  isChromeToHostMsg,
  isToolRequestMsg,
  toolError,
  type ChromeToHostMsg,
  type SocketClientMsg,
} from "@opencode-in-chrome/shared"

export const NATIVE_HOST_VERSION = PROTOCOL_VERSION + ".0"

function log(msg: string): void {
  process.stderr.write(`[oc-chrome-host ${pid}] ${msg}\n`)
}

// Structured relay trace, opt-in via OCIC_TRACE=<file> — debug aid for
// multiplexing issues; zero cost when unset.
const TRACE = process.env["OCIC_TRACE"] ?? ""
let traceSeq = 0
function trace(msg: string, extra?: unknown): void {
  if (!TRACE) return
  void appendFile(TRACE, `${++traceSeq}\t${Date.now()}\t${msg}${extra === undefined ? "" : `\t${JSON.stringify(extra)}`}\n`).catch(
    () => {},
  )
}

type SocketClient = {
  id: string
  socket: Socket
  reader: FrameReader
}

export class NativeHost {
  private chromeReader = new FrameReader()
  private clients = new Map<string, SocketClient>()
  private nextClientId = 0
  private server: Server | null = null
  /** True once the extension completed its handshake (sends `ping` after connectNative). */
  private extensionConnected = false
  readonly socketPath: string

  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  async start(): Promise<void> {
    await this.listen()
    stdin.on("data", (chunk: Buffer) => this.onChromeData(chunk))
    stdin.on("end", () => this.stop("chrome closed stdin"))
    stdin.on("error", () => this.stop("stdin error"))
    stdin.resume()
    log(`listening on ${this.socketPath} (host: ${currentPlatform()})`)
    // Heartbeat toward the extension while any MCP client is connected: the MV3
    // service worker freezes ~30 s without events (Chrome throttles alarms to
    // ≥1 min), which silently ate in-flight tool_requests. A port message每 25 s
    // resets the SW idle timer exactly while a session exists.
    this.heartbeat = setInterval(() => {
      if (!this.extensionConnected || this.clients.size === 0) return
      trace("heartbeat → chrome", { clients: this.clients.size })
      this.sendToChrome({ type: "notification", event: "keepalive" })
    }, 25_000)
  }

  private heartbeat: ReturnType<typeof setInterval> | null = null

  private async listen(): Promise<void> {
    const dir = bridgeDir()
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await this.cleanStaleSockets(dir)
    this.server = createServer((socket) => this.onClientConnected(socket))
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject)
      this.server?.listen(this.socketPath, () => resolve())
    })
    if (currentPlatform() !== "win32") {
      await chmod(this.socketPath, 0o600).catch(() => {})
    }
  }

  /** Removes sockets of dead host processes (same sweep pattern as the reference impls). */
  private async cleanStaleSockets(dir: string): Promise<void> {
    if (currentPlatform() === "win32") return // named pipes die with their process
    const entries = await readdir(dir).catch(() => [])
    for (const name of entries) {
      const m = /^bridge-(\d+)\.sock$/.exec(name)
      if (!m || m[1] === String(pid)) continue
      const otherPid = Number(m[1])
      try {
        process.kill(otherPid, 0) // alive → keep
      } catch {
        await rm(`${dir}/${name}`, { force: true })
        log(`removed stale socket for dead pid ${otherPid}`)
      }
    }
  }

  // ── Chrome side ────────────────────────────────────────────────────────────

  private onChromeData(chunk: Buffer): void {
    let frames: unknown[]
    try {
      frames = this.chromeReader.push(chunk)
    } catch (err) {
      log(`chrome frame error: ${(err as Error).message}`)
      return
    }
    for (const frame of frames) {
      if (!isChromeToHostMsg(frame)) {
        log(`ignoring invalid chrome message`)
        continue
      }
      this.handleChromeMessage(frame as ChromeToHostMsg)
    }
  }

  private handleChromeMessage(msg: ChromeToHostMsg): void {
    trace(`chrome→host ${msg.type}`, (msg as { id?: string; tool?: string }).id ?? (msg as { tool?: string }).tool)
    switch (msg.type) {
      case "ping":
        this.extensionConnected = true
        this.sendToChrome({ type: "pong", timestamp: Date.now() })
        break
      case "get_status":
        this.sendToChrome({
          type: "status_response",
          nativeHostVersion: NATIVE_HOST_VERSION,
          hostPid: pid,
          socketPath: this.socketPath,
          mcpClients: this.clients.size,
          extensionConnected: this.extensionConnected,
        })
        break
      case "tool_response": {
        // id arrives namespaced as "<clientId>:<reqId>"; route and un-namespace.
        const sep = msg.id.indexOf(":")
        const clientId = sep >= 0 ? msg.id.slice(0, sep) : msg.id
        const client = this.clients.get(clientId)
        if (client) {
          const outbound = sep >= 0 ? { ...msg, id: msg.id.slice(sep + 1) } : msg
          trace(`route tool_response → client`, { clientId, size: JSON.stringify(outbound).length })
          this.sendToClient(client, outbound)
        } else {
          log(`tool_response for unknown client (id=${msg.id})`)
          trace(`tool_response ROUTE MISS`, { id: msg.id, clients: [...this.clients.keys()] })
        }
        break
      }
      case "notification":
        for (const client of this.clients.values()) this.sendToClient(client, msg)
        break
    }
  }

  private sendToChrome(msg: unknown): void {
    try {
      stdout.write(encodeFrame(msg))
    } catch (err) {
      log(`send-to-chrome failed: ${(err as Error).message}`)
    }
  }

  // ── Socket-client (MCP) side ──────────────────────────────────────────────

  private onClientConnected(socket: Socket): void {
    const id = `cli${this.nextClientId++}`
    const client: SocketClient = { id, socket, reader: new FrameReader() }
    this.clients.set(id, client)
    log(`mcp client ${id} connected (total ${this.clients.size})`)
    this.sendToChrome({ type: "mcp_connected", clientId: id })

    socket.on("data", (chunk: Buffer) => {
      let frames: unknown[]
      try {
        frames = client.reader.push(chunk)
      } catch {
        socket.destroy()
        return
      }
      for (const frame of frames) {
        const msg: SocketClientMsg = frame as SocketClientMsg
        if (msg?.type === "ping") {
          this.sendToClient(client, { type: "pong", timestamp: Date.now() })
          continue
        }
        if (isToolRequestMsg(msg)) {
          if (!this.extensionConnected) {
            // Deterministic failure instead of writing to a dead pipe.
            trace(`client tool_request but extension NOT connected`, { id: msg.id, tool: msg.tool })
            this.sendToClient(
              client,
              toolError(msg, "extension not connected — open Chrome with the opencode-in-chrome extension"),
            )
            continue
          }
          // Namespace the correlation id per client: "<clientId>:<requestId>"
          trace(`client tool_request → chrome`, { tool: msg.tool, id: msg.id })
          this.sendToChrome({
            ...msg,
            id: `${id}:${msg.id}`,
          })
        } else {
          this.sendToClient(client, toolError({ type: "tool_request", id: "?", tool: "?", args: null, clientId: id }, "invalid tool_request frame"))
        }
      }
    })

    const disconnect = () => {
      this.clients.delete(id)
      trace(`client disconnected`, { id })
      log(`mcp client ${id} disconnected (total ${this.clients.size})`)
      this.sendToChrome({ type: "mcp_disconnected", clientId: id })
    }
    socket.on("close", disconnect)
    socket.on("error", disconnect)
  }

  private sendToClient(client: SocketClient, msg: unknown): void {
    try {
      client.socket.write(encodeFrame(msg))
    } catch (err) {
      log(`send-to-client failed: ${(err as Error).message}`)
    }
  }

  async stop(reason: string): Promise<void> {
    log(`stopping: ${reason}`)
    trace(`stop`, { reason })
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.server?.close()
    for (const client of this.clients.values()) client.socket.destroy()
    this.clients.clear()
    if (currentPlatform() !== "win32") {
      await rm(this.socketPath, { force: true })
    }
    process.exit(0)
  }
}

// Entry point when executed directly (by Chrome via the wrapper script).
if (process.argv[1]?.includes("native-host") || process.env["OC_CHROME_NATIVE_HOST"] === "1") {
  const host = new NativeHost(socketPathForPid(pid))
  host.start().catch((err) => {
    log(`fatal: ${(err as Error).message}`)
    process.exit(1)
  })
}

export { HOST_NAME }
