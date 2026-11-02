/**
 * Native-host spike — the "Bun gate" from Fase 0.
 *
 * Spawns the host the same way Chrome would (stdin pipe + protocol frames) and
 * verifies the full handshake. Runs in CI on ubuntu/macos/windows — this is the
 * insurance against the Bun <1.4 Windows named-pipe/stdin panics that broke
 * Claude Code's equivalent host (issues #21418, #21935, #24366).
 */

import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { connect } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { encodeFrame, FrameReader } from "@opencode-in-chrome/shared"

const HOST_TS = join(fileURLToPath(import.meta.url), "..", "..", "src", "native-host", "host.ts")
const children: ReturnType<typeof spawn>[] = []

afterAll(() => {
  for (const c of children) {
    try {
      c.kill()
    } catch {
      // already gone
    }
  }
})

/** Spawns the host under the current runtime and pipes frames in both directions. */
function startHost(): {
  send: (msg: unknown) => void
  read: () => Promise<unknown>
  stderr: string
} {
  const bunPath = process.execPath // bun when running bun test
  const child = spawn(bunPath, ["run", HOST_TS], { stdio: ["pipe", "pipe", "pipe"] })
  children.push(child)

  const reader = new FrameReader()
  let stderr = ""
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf8")
  })

  const queue: unknown[] = []
  let notify: (() => void) | null = null
  child.stdout?.on("data", (d: Buffer) => {
    for (const frame of reader.push(d)) {
      queue.push(frame)
      notify?.()
    }
  })

  const read = () =>
    new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for host message; stderr:\n${stderr}`)), 10_000)
      const pump = () => {
        const next = queue.shift()
        if (next !== undefined) {
          clearTimeout(timer)
          resolve(next)
          return
        }
        notify = pump
      }
      pump()
    })

  const send = (msg: unknown) => {
    child.stdin?.write(encodeFrame(msg))
  }

  return { send, read, stderr: "" }
}

/** Opens a socket-client connection with id-matched response queue (MCP client stand-in). */
function openClient(socketPath: string): {
  id: string
  write: (buf: Buffer) => void
  read: () => Promise<unknown>
  destroy: () => void
} {
  const id = `test${Date.now() % 1000}`
  const socket = connect(socketPath)
  const reader = new FrameReader()
  const queue: { id?: string }[] = []
  let notify: (() => void) | null = null
  socket.on("data", (d: Buffer) => {
    for (const f of reader.push(d)) {
      queue.push(f as { id?: string })
      notify?.()
    }
  })
  return {
    id,
    write: (buf: Buffer) => socket.write(buf),
    read: () =>
      new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout on socket client")), 10_000)
        const pump = () => {
          const next = queue.shift()
          if (next !== undefined) {
            clearTimeout(timer)
            resolve(next)
            return
          }
          notify = pump
        }
        pump()
      }),
    destroy: () => socket.destroy(),
  }
}

describe("native host handshake (Chrome protocol)", () => {
  test("ping → pong", async () => {
    const h = startHost()
    h.send({ type: "ping" })
    const msg = (await h.read()) as { type?: string; timestamp?: number }
    expect(msg.type).toBe("pong")
    expect(typeof msg.timestamp).toBe("number")
  })

  test("get_status → status_response with socket path", async () => {
    const h = startHost()
    h.send({ type: "get_status" })
    const msg = (await h.read()) as {
      type?: string
      nativeHostVersion?: string
      socketPath?: string
      mcpClients?: number
      defaultScratchDir?: string
    }
    expect(msg.type).toBe("status_response")
    expect(typeof msg.nativeHostVersion).toBe("string")
    expect(msg.socketPath).toContain("oc-chrome")
    expect(msg.mcpClients).toBe(0)
    expect(msg.defaultScratchDir).toMatch(/opencode-chrome$/)
  })

  test("socket client: tool_request with no extension → typed error with correlation id", async () => {
    const h = startHost()

    // Wait for the socket path via status (also proves the listener is up).
    h.send({ type: "get_status" })
    const status = (await h.read()) as { socketPath?: string }
    const socketPath = status.socketPath

    const client = openClient(socketPath!)

    // Client sends a tool_request; the extension has NOT performed its handshake
    // (no ping in this test), so the host must answer a typed error bound to our
    // correlation id (multiplexing contract) instead of forwarding to a dead pipe.
    client.write(encodeFrame({ type: "tool_request", id: "req-1", tool: "tabs_context", args: {}, clientId: "test" }))
    const resp = (await client.read()) as { type?: string; id?: string; ok?: boolean }
    expect(resp.type).toBe("tool_response")
    expect(resp.id).toBe("req-1") // direct error echoes the client's own correlation id
    expect(resp.ok).toBe(false)
    client.destroy()
  }, 15_000)

  test("extension-sourced ERROR tool_response routes back un-namespaced (regression: guard dropped error responses)", async () => {
    const h = startHost()
    h.send({ type: "ping" }) // extension handshake → extensionConnected = true
    await h.read() // pong (mark connected)

    h.send({ type: "get_status" })
    const status = (await h.read()) as { socketPath?: string; extensionConnected?: boolean }
    expect(status.extensionConnected).toBe(true)

    const client = openClient(status.socketPath!)
    // Send an error-shaped tool_response AS IF it came from the extension.
    // NOTE: the host namespaces client ids as "cli<N>" (first client = cli0).
    h.send({
      type: "tool_response",
      id: `cli0:err-42`,
      ok: false,
      error: { message: "foreign tab" },
    })
    const resp = (await client.read()) as {
      type?: string
      id?: string
      ok?: boolean
      error?: { message?: string }
    }
    expect(resp.type).toBe("tool_response")
    expect(resp.id).toBe("err-42")
    expect(resp.ok).toBe(false)
    expect(resp.error?.message).toBe("foreign tab")
    client.destroy()
  }, 15_000)
})
