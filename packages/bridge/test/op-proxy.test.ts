/**
 * op-proxy tests — the Modo B wire, pinned twice:
 *   1. unit: service discovery (I4 — the password never leaves the host), op routing (arg cuts,
 *      id escaping), SSE frame parsing (opencode v2 shape + heartbeats)
 *   2. integration: the REAL host process speaks to a mock OpenCode server and
 *      the panel-facing op_request → op_response / op_event frames come back
 *      correct, including the Authorization header (utf-8 password).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { encodeFrame, FrameReader } from "@opencode-in-chrome/shared"
import { authHeader, opFetch, opRoute, parseSseFrame, readServiceInfo } from "../src/native-host/op-proxy"

const HOST_TS = join(fileURLToPath(import.meta.url), "..", "..", "src", "native-host", "host.ts")
const children: ChildProcess[] = []
const tempDirs: string[] = []

afterAll(() => {
  for (const c of children) {
    try {
      c.kill()
    } catch {}
  }
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

// ── unit ─────────────────────────────────────────────────────────────────────

describe("op-proxy unit", () => {
  test("readServiceInfo trims the url and honors XDG_STATE_HOME", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocic-op-"))
    tempDirs.push(dir)
    mkdirSync(join(dir, "opencode"), { recursive: true })
    writeFileSync(
      join(dir, "opencode", "service.json"),
      JSON.stringify({ url: "http://127.0.0.1:9999/", password: "pw-π" }),
    )
    const prev = process.env["XDG_STATE_HOME"]
    process.env["XDG_STATE_HOME"] = dir
    try {
      const info = await readServiceInfo()
      expect(info.url).toBe("http://127.0.0.1:9999")
      expect(info.password).toBe("pw-π")
      // utf8 password, not latin1 — pinned at the HTTP layer too (integration)
      expect(authHeader(info)).toBe(`Basic ${Buffer.from("opencode:pw-π", "utf8").toString("base64")}`)
    } finally {
      if (prev === undefined) delete process.env["XDG_STATE_HOME"]
      else process.env["XDG_STATE_HOME"] = prev
    }
  })

  test("readServiceInfo fails with honest guidance when the server is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocic-op-empty-"))
    tempDirs.push(dir)
    const prev = process.env["XDG_STATE_HOME"]
    process.env["XDG_STATE_HOME"] = dir
    try {
      await expect(readServiceInfo()).rejects.toThrow("start OpenCode")
      let code = ""
      await readServiceInfo().catch((err: { code?: string }) => {
        code = err.code ?? ""
      })
      expect(code).toBe("server_not_running")
    } finally {
      if (prev === undefined) delete process.env["XDG_STATE_HOME"]
      else process.env["XDG_STATE_HOME"] = prev
    }
  })

  test("readServiceInfo rejects an incomplete registration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocic-op-bad-"))
    tempDirs.push(dir)
    mkdirSync(join(dir, "opencode"), { recursive: true })
    writeFileSync(join(dir, "opencode", "service.json"), JSON.stringify({ url: "http://127.0.0.1:1" }))
    const prev = process.env["XDG_STATE_HOME"]
    process.env["XDG_STATE_HOME"] = dir
    try {
      let code = ""
      await readServiceInfo().catch((err: { code?: string }) => {
        code = err.code ?? ""
      })
      expect(code).toBe("server_not_running")
    } finally {
      if (prev === undefined) delete process.env["XDG_STATE_HOME"]
      else process.env["XDG_STATE_HOME"] = prev
    }
  })

  test("readServiceInfo rejects a malformed JSON registration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocic-op-json-"))
    tempDirs.push(dir)
    mkdirSync(join(dir, "opencode"), { recursive: true })
    writeFileSync(join(dir, "opencode", "service.json"), "{not json")
    const prev = process.env["XDG_STATE_HOME"]
    process.env["XDG_STATE_HOME"] = dir
    try {
      let message = ""
      await readServiceInfo().catch((err: Error) => {
        message = err.message
      })
      expect(message).toContain("malformed")
    } finally {
      if (prev === undefined) delete process.env["XDG_STATE_HOME"]
      else process.env["XDG_STATE_HOME"] = prev
    }
  })

  test("opFetch maps missing service / 401 / unreachable to typed codes", async () => {
    const prev = process.env["XDG_STATE_HOME"]

    const empty = mkdtempSync(join(tmpdir(), "ocic-op-missing-"))
    tempDirs.push(empty)
    process.env["XDG_STATE_HOME"] = empty
    try {
      const missing = await opFetch("GET", "/api/info")
      expect(missing.ok).toBe(false)
      if (!missing.ok) expect(missing.error.code).toBe("server_not_running")
    } finally {
      if (prev === undefined) delete process.env["XDG_STATE_HOME"]
      else process.env["XDG_STATE_HOME"] = prev
    }

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        return new Response("x", { status: path === "/auth" ? 401 : 500 })
      },
    })
    const dir = mkdtempSync(join(tmpdir(), "ocic-op-codes-"))
    tempDirs.push(dir)
    mkdirSync(join(dir, "opencode"), { recursive: true })
    writeFileSync(
      join(dir, "opencode", "service.json"),
      JSON.stringify({ url: `http://127.0.0.1:${server.port}`, password: "pw" }),
    )
    process.env["XDG_STATE_HOME"] = dir
    try {
      const auth = await opFetch("GET", "/auth")
      expect(auth.ok).toBe(false)
      if (!auth.ok) expect(auth.error.code).toBe("server_auth_failed")

      const bad = await opFetch("GET", "/bad")
      expect(bad.ok).toBe(false)
      if (!bad.ok) expect(bad.error.code).toBe("server_error")

      writeFileSync(
        join(dir, "opencode", "service.json"),
        JSON.stringify({ url: "http://127.0.0.1:1", password: "pw" }),
      )
      const down = await opFetch("GET", "/api/info")
      expect(down.ok).toBe(false)
      if (!down.ok) expect(down.error.code).toBe("server_unreachable")
    } finally {
      server.stop(true)
      if (prev === undefined) delete process.env["XDG_STATE_HOME"]
      else process.env["XDG_STATE_HOME"] = prev
    }
  })

  test("opRoute cuts unknown args and escapes ids", () => {
    const prompt = opRoute("prompt", { sessionId: "ses/1 bad", text: "hi", INJECTED: "x" }) as {
      path: string
      method: string
      body: { text?: string; INJECTED?: unknown }
    }
    expect(prompt.path).toBe("/api/session/ses%2F1%20bad/prompt")
    expect(prompt.method).toBe("POST")
    expect(prompt.body!.text).toBe("hi")
    expect(prompt.body!.INJECTED).toBeUndefined()

    expect(() => opRoute("__nonexistent__", {})).toThrow('unknown op "__nonexistent__"')
  })

  test("list_sessions filters by directory when asked (panel scratch view)", () => {
    const scoped = opRoute("list_sessions", { directory: "/tmp/oc scratch" }) as { path: string }
    expect(scoped.path).toBe("/api/session?directory=%2Ftmp%2Foc%20scratch")
    const all = opRoute("list_sessions", {}) as { path: string }
    expect(all.path).toBe("/api/session")
  })

  test("parseSseFrame knows opencode v2 frames and ignores heartbeats", () => {
    const ok = parseSseFrame('data: {"id":"evt_x","type":"server.connected","data":{}}')
    expect(ok).toEqual({ event: "server.connected", properties: {} })
    const payload = parseSseFrame('data: {"type":"message.updated","data":{"info":{"id":"m1"}}}')
    expect(payload).toEqual({ event: "message.updated", properties: { info: { id: "m1" } } })
    expect(parseSseFrame(": heartbeat")).toBeNull()
    expect(parseSseFrame("")).toBeNull()
    expect(parseSseFrame("data: not-json")).toBeNull()
  })
})

// ── integration: the real host ↔ a mock OpenCode server ──────────────────────

describe("host op proxy (integration)", () => {
  let observed: { auth: string | null; path: string }
  let ssePush: ((s: string) => void) | null = null

  const startMockServer = async () => {
    const encoder = new TextEncoder()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url)
        observed = { auth: req.headers.get("authorization") ?? null, path: url.pathname }
        if (url.pathname === "/api/event") {
          const stream = new ReadableStream({
            start(controller) {
              ssePush = (s: string) => controller.enqueue(encoder.encode(s))
              ssePush('data: {"id":"evt_m1","type":"server.connected","data":{}}\n\n')
              // stream stays open (host pipe pulls)
            },
            cancel() {
              ssePush = null
            },
          })
          return new Response(stream, { headers: { "content-type": "text/event-stream" } })
        }
        if (url.pathname === "/api/session") {
          return Response.json({ location: { directory: "/scratch" }, data: [{ id: "ses_1", title: "t1" }] })
        }
        return new Response("not found", { status: 404 })
      },
    })
    return {
      stop: () => server.stop(true),
      port: server.port,
      push: async (s: string) => ssePush?.(s),
    }
  }

  test("host returns a typed server_not_running when service.json is absent", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ocic-op-down-"))
    tempDirs.push(stateDir)
    const child = spawn(process.execPath, ["run", HOST_TS], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, XDG_STATE_HOME: stateDir },
    })
    children.push(child)
    const reader = new FrameReader()
    const frames: Array<Record<string, unknown>> = []
    let notify: (() => void) | null = null
    child.stdout?.on("data", (d: Buffer) => {
      for (const f of reader.push(d)) {
        frames.push(f as Record<string, unknown>)
        notify?.()
      }
    })
    const next = (want: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting ${want}`)), 9000)
        const pump = () => {
          const idx = frames.findIndex((f) => f["type"] === want)
          if (idx >= 0) {
            const hit = frames.splice(idx, 1)[0] as Record<string, unknown>
            clearTimeout(timer)
            resolve(hit)
            return
          }
          notify = pump
        }
        pump()
      })
    const send = (msg: unknown) => child.stdin?.write(encodeFrame(msg))

    send({ type: "ping" })
    await next("pong")
    send({ type: "op_request", id: "down-1", op: "info" })
    const resp = (await next("op_response")) as {
      id?: string
      ok?: boolean
      error?: { code?: string; message?: string }
    }
    expect(resp.id).toBe("down-1")
    expect(resp.ok).toBe(false)
    expect(resp.error?.code).toBe("server_not_running")
    child.stdin?.end()
  }, 20_000)

  test("op_request → op_response through the real host process (auth + envelope)", async () => {
    const mock = await startMockServer()
    const stateDir = mkdtempSync(join(tmpdir(), "ocic-op-host-"))
    tempDirs.push(stateDir)
    mkdirSync(join(stateDir, "opencode"), { recursive: true })
    writeFileSync(
      join(stateDir, "opencode", "service.json"),
      JSON.stringify({ url: `http://127.0.0.1:${mock.port}`, password: "test-pass-π" }),
    )

    const child = spawn(process.execPath, ["run", HOST_TS], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, XDG_STATE_HOME: stateDir },
    })
    children.push(child)
    const reader = new FrameReader()
    const frames: Array<Record<string, unknown>> = []
    let notify: (() => void) | null = null
    let stderr = ""
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")))
    child.stdout?.on("data", (d: Buffer) => {
      for (const f of reader.push(d)) {
        frames.push(f as Record<string, unknown>)
        notify?.()
      }
    })
    const next = (want: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting ${want}; stderr: ${stderr}`)), 9000)
        const pump = () => {
          const idx = frames.findIndex((f) => f["type"] === want)
          if (idx >= 0) {
            const hit = frames.splice(idx, 1)[0] as Record<string, unknown> // consume — sequential protocol
            clearTimeout(timer)
            resolve(hit)
            return
          }
          notify = pump
        }
        pump()
      })

    const send = (msg: unknown) => child.stdin?.write(encodeFrame(msg))

    send({ type: "ping" })
    await next("pong") // handshake → extensionConnected (op_event broadcasts need it)

    send({ type: "op_request", id: "o1", op: "list_sessions" })
    const resp = (await next("op_response")) as { id?: string; ok?: boolean; result?: { data?: unknown[] } }
    expect(resp.id).toBe("o1")
    expect(resp.ok).toBe(true)
    expect((resp.result?.data as Array<{ id?: string }>)?.[0]?.id).toBe("ses_1")
    // I4 at the wire: the password crossed as utf-8 basic auth, held by the host only
    expect(observed.auth).toBe(`Basic ${Buffer.from("opencode:test-pass-π", "utf8").toString("base64")}`)

    send({ type: "op_request", id: "o2", op: "__nonexistent__" })
    const bad = (await next("op_response")) as { id?: string; ok?: boolean; error?: { message?: string } }
    expect(bad.id).toBe("o2")
    expect(bad.ok).toBe(false)
    expect(bad.error?.message).toContain('unknown op "__nonexistent__"')

    // SSE pipe: events_on → op_event broadcast visible to the extension side
    send({ type: "op_request", id: "o3", op: "events_on" })
    const on = (await next("op_response")) as { id?: string; result?: { streaming?: boolean } }
    expect(on.result?.streaming).toBe(true)
    const ev = (await next("op_event")) as { event?: string; properties?: unknown }
    expect(ev.event).toBe("server.connected")
    expect(ev.properties).toEqual({})

    child.stdin?.end()
    try {
      mock.stop()
    } catch {}
  }, 20_000)
})
