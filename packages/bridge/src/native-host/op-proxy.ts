/**
 * op-proxy.ts — Modo B transport (T17): the OpenCode HTTP operations the panel
 * needs, routed through the bridge host.
 *
 * Security invariant I4: the basic-auth password lives ONLY in this process
 * (host), read from the user's opencode service.json — the extension never sees
 * credentials, and nothing here logs the url/password.
 *
 * Server contracts verified live against OpenCode V2.0.32 (specs/06):
 *   GET  /api/info                 → {version, pid, urls[], ...}
 *   GET  /api/session              → envelope {location:{directory}, data:[...]}
 *   POST /api/session              {title?, location{directory}?, agent?} → {data:{id,...}}
 *   GET  /api/session/{id}/message → session transcript (V2 shape passthrough)
 *   POST /api/session/{id}/prompt  {text, files?} → async; results stream on /api/event
 *   GET  /api/model                → envelope .data = 497 models {providerID, modelID,
 *                                    name, enabled, status, ...}
 *   GET  /api/agent                → envelope .data = agents {id, mode, hidden, ...}
 *   GET  /api/event (SSE)          → frames `data: {"id","type","data"}` + `: heartbeat`
 *
 * Service discovery (C10): the port re-binds on every server start, so the
 * service.json is re-read per fetch — never cached.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { isRecord } from "@opencode-in-chrome/shared"

export type ServiceInfo = {
  url: string
  password: string
}

/** Resolves the live OpenCode service credentials, re-reading every time (C10). */
export async function readServiceInfo(): Promise<ServiceInfo> {
  const state = process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state")
  const candidates = [
    join(state, "opencode", "service.json"),
    join(homedir(), ".config", "opencode", "service.json"),
  ]
  let url = ""
  let password = ""
  for (const file of candidates) {
    if (!file) continue
    try {
      const cfg = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
      url = url || (typeof cfg["url"] === "string" ? cfg["url"] : "")
      password = password || (typeof cfg["password"] === "string" ? cfg["password"] : "")
    } catch {
      /* file absent/unreadable → try the next source */
    }
    if (url && password) break
  }
  if (!password) throw new Error("OpenCode service credentials not found — start OpenCode first (service.json missing)")
  if (!url) throw new Error("OpenCode service url not found — start OpenCode first")
  return { url: url.replace(/\/$/, ""), password }
}

export function authHeader(info: ServiceInfo): string {
  // Buffer (not btoa): passwords are arbitrary UTF-8, not just latin1.
  return `Basic ${Buffer.from(`opencode:${info.password}`, "utf8").toString("base64")}`
}

/** Maps an op name + args to the REST shape of the live server. */
export function opRoute(op: string, args: unknown): { path: string; method: "GET" | "POST" | "PATCH"; body?: unknown } {
  const a = isRecord(args) ? args : {}
  const str = (k: string) => {
    const v = a[k]
    return typeof v === "string" ? v : ""
  }
  switch (op) {
    case "info":
      return { path: "/api/info", method: "GET" }
    case "list_sessions": {
      const dir = typeof a["directory"] === "string" && a["directory"] ? `?directory=${encodeURIComponent(a["directory"])}` : ""
      return { path: `/api/session${dir}`, method: "GET" }
    }
    case "create_session":
      return {
        path: "/api/session",
        method: "POST",
        body: pick(a, ["title", "location", "agent", "model", "permissions", "parentID"]),
      }
    case "patch_session":
      // Live model/agent switch (verified: PATCH /api/session/{id} {model} →
      // next step runs on the new model).
      if (!str("sessionId")) throw new Error("patch_session: sessionId required")
      return {
        path: `/api/session/${encodeURIComponent(str("sessionId"))}`,
        method: "PATCH",
        body: pick(a, ["model", "agent", "title"]),
      }
    case "session_messages": {
      if (!str("sessionId")) throw new Error("session_messages: sessionId required")
      return { path: `/api/session/${encodeURIComponent(str("sessionId"))}/message`, method: "GET" }
    }
    case "prompt": {
      // NOTE (verified live): the server IGNORES model/agent in prompt bodies —
      // the model is pinned at session creation; the panel asks before "+ new chat".
      if (!str("sessionId")) throw new Error("prompt: sessionId required")
      return {
        path: `/api/session/${encodeURIComponent(str("sessionId"))}/prompt`,
        method: "POST",
        body: pick(a, ["text", "files", "tools"]),
      }
    }
    case "list_models":
      return { path: "/api/model", method: "GET" }
    case "list_agents":
      return { path: "/api/agent", method: "GET" }
    case "interrupt":
      // Verified live: POST /api/session/{id}/interrupt → step.failed +
      // session.execution.interrupted (killed a mid-reasoning step).
      if (!str("sessionId")) throw new Error("interrupt: sessionId required")
      return { path: `/api/session/${encodeURIComponent(str("sessionId"))}/interrupt`, method: "POST" }
    case "permission_reply": {
      // Verified live: 204; permission.replied follows and the tool runs.
      if (!str("sessionId") || !str("requestId")) throw new Error("permission_reply: sessionId + requestId required")
      return {
        path: `/api/session/${encodeURIComponent(str("sessionId"))}/permission/${encodeURIComponent(str("requestId"))}/reply`,
        method: "POST",
        body: { decision: str("decision") || "once" },
      }
    }
    default:
      throw new Error(`unknown op "${op}"`)
  }
}

export type OpFetchResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { message: string } }

/** One authenticated call to the local server; timeouts keep Chrome's pipe honest. */
export async function opFetch(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<OpFetchResult> {
  const info = await readServiceInfo()
  try {
    const res = await fetch(`${info.url}${path}`, {
      method,
      headers: {
        Authorization: authHeader(info),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { ok: false, error: { message: `opencode server ${res.status} ${res.statusText} — ${method} ${path}` } }
    if (res.status === 204) return { ok: true, result: null }
    return { ok: true, result: await res.json().catch(() => null) }
  } catch (err) {
    const e = err as Error
    const why = e.name === "TimeoutError" ? "timed out after 10 s" : e.message
    return { ok: false, error: { message: `opencode server unreachable (${why}) — ${method} ${path}` } }
  }
}

/** Parses one SSE frame ("data:"-line block); returns null for comments/blank frames. */
export function parseSseFrame(frame: string): { event: string; properties: unknown } | null {
  const data: string[] = []
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
  }
  if (data.length === 0) return null // heartbeats / comments / keepalives
  let doc: unknown
  try {
    doc = JSON.parse(data.join("\n"))
  } catch {
    return null
  }
  // OpenCode v2 SSE: {"id","type","data"} — the event name lives in `type`.
  if (isRecord(doc) && typeof doc["type"] === "string") {
    return { event: doc["type"], properties: doc["data"] ?? {} }
  }
  // Generic fallback: name may have arrived on the standard event: line.
  return { event: "unknown", properties: doc }
}

export function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k]
  }
  return out
}
