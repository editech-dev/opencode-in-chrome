/**
 * OpenCode in Chrome — service worker (M0 skeleton).
 *
 * Responsibilities:
 *  - own the native messaging port to `com.opencodeinchrome.bridge`
 *    (Chrome spawns the host on connectNative — the user never runs anything);
 *  - keep the SW alive with a ping/latido (MV3 workers idle after ~30 s);
 *  - answer tool_request frames (dispatcher lands in Fase 1 — M1);
 *  - broadcast bridge status to the side panel via runtime messages + storage.
 *
 * Protocol: 4-byte UInt32LE length prefix + UTF-8 JSON (see packages/shared).
 */

const HOST_NAME = "com.opencodeinchrome.bridge"
const PING_PERIOD_MIN = 0.5 // 30 s — below the MV3 idle timeout

let port = null
let connected = false
let lastStatus = {
  type: "disconnected",
  hostVersion: null,
  mcpClients: 0,
  extensionConnected: false,
}

// ── Frame codec (browser-side; Buffer is not available in MV3 workers) ───────

class FrameReader {
  constructor() {
    this.buf = new Uint8Array(0)
  }

  /** Feed bytes; returns decoded JSON values. */
  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.byteLength)
    merged.set(this.buf, 0)
    merged.set(new Uint8Array(chunk), this.buf.length)
    this.buf = merged

    const out = []
    for (;;) {
      if (this.buf.byteLength < 4) break
      const view = new DataView(this.buf.buffer)
      const len = view.getUint32(0, true) // little-endian
      if (len === 0 || len > 64 * 1024 * 1024) throw new Error(`invalid frame length ${len}`)
      if (this.buf.byteLength < 4 + len) break
      const body = new TextDecoder().decode(this.buf.subarray(4, 4 + len))
      this.buf = this.buf.subarray(4 + len)
      out.push(JSON.parse(body))
    }
    return out
  }
}

function encodeFrame(value) {
  const body = new TextEncoder().encode(JSON.stringify(value))
  const head = new Uint8Array(4)
  new DataView(head.buffer).setUint32(0, body.byteLength, true)
  const frame = new Uint8Array(4 + body.byteLength)
  frame.set(head, 0)
  frame.set(body, 4)
  return frame
}

// ── Status plumbing ──────────────────────────────────────────────────────────

function setStatus(patch) {
  lastStatus = { ...lastStatus, ...patch, updatedAt: new Date().toISOString() }
  chrome.storage.local.set({ bridgeStatus: lastStatus }).catch(() => {})
  chrome.runtime
    .sendMessage({ kind: "bridgeStatus", status: lastStatus })
    .catch(() => {}) // side panel may be closed
}

// ── Native messaging port ────────────────────────────────────────────────────

function connectHost() {
  try {
    port = chrome.runtime.connectNative(HOST_NAME)
  } catch (err) {
    setStatus({ type: "host_missing", detail: String(err) })
    scheduleReconnect()
    return
  }

  const reader = new FrameReader()
  port.onMessage.addListener((raw) => {
    let msgs
    try {
      msgs = reader.push(raw)
    } catch {
      return
    }
    for (const msg of msgs) handleHostMessage(msg)
  })

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message ?? "host exited"
    connected = false
    port = null
    setStatus({ type: "disconnected", detail: err })
    scheduleReconnect()
  })

  connected = true
  setStatus({ type: "connected", detail: null })
  port.postMessage(encodeFrame({ type: "ping" }))
  pingHost()
}

function pingHost() {
  if (port) port.postMessage(encodeFrame({ type: "ping" }))
}

function handleHostMessage(msg) {
  switch (msg?.type) {
    case "pong":
      setStatus({ type: "connected", hostVersion: msg.nativeHostVersion ?? lastStatus.hostVersion })
      break
    case "status_response":
      setStatus({
        type: "connected",
        hostVersion: msg.nativeHostVersion,
        mcpClients: msg.mcpClients,
        extensionConnected: msg.extensionConnected,
      })
      break
    case "mcp_connected":
    case "mcp_disconnected":
      pingHost() // refresh mcpClients count on the next status
      break
    case "tool_request":
      // Fase 1 (M1) implements the dispatcher; answer deterministically meanwhile.
      port?.postMessage(
        encodeFrame({
          type: "tool_response",
          id: msg.id,
          ok: false,
          error: { message: "browser tools land in Fase 1 (M1) — connection is healthy" },
        }),
      )
      break
    case "notification":
      chrome.notifications?.create({
        type: "basic",
        title: "OpenCode in Chrome",
        message: String(msg.event ?? ""),
      })
      break
    default:
      break
  }
}

// ── Keep-alive & reconnection ────────────────────────────────────────────────

let reconnectAttempts = 0

function scheduleReconnect() {
  const delay = Math.min(30_000, 500 * 2 ** reconnectAttempts++)
  setTimeout(() => {
    if (!port) connectHost()
  }, delay)
}

chrome.alarms.create("keepalive", { periodInMinutes: PING_PERIOD_MIN })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "keepalive") return
  if (port) {
    pingHost()
  } else {
    connectHost()
  }
})

// ── Side panel messaging ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === "getStatus") {
    sendResponse(lastStatus)
  }
  return false // no async response
})

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {}) // older Chromium builds

chrome.runtime.onInstalled.addListener(() => connectHost())
chrome.runtime.onStartup.addListener(() => connectHost())

// SW may be revived without install/startup events — try immediately.
if (!port) connectHost()
