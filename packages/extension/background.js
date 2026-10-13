/**
 * OpenCode in Chrome — service worker (M0 skeleton).
 *
 * Responsibilities:
 *  - own the native messaging port to `com.opencodeinchrome.bridge`
 *    (Chrome spawns the host on connectNative — the user never runs anything);
 *  - keep the SW alive with a keepalive alarm (MV3 workers idle after ~30 s);
 *  - answer tool_request messages (dispatcher lands in Fase 1 — M1);
 *  - broadcast bridge status to the side panel via runtime messages + storage.
 *
 * IMPORTANT (Chrome native messaging): Chrome does the framing for us.
 *  - port.postMessage(obj) → Chrome serializes + prefixes 4B-LE length → host stdin;
 *  - host stdout frames → Chrome parses → port.onMessage delivers plain objects.
 * The bridge side (packages/bridge) does the raw 4B-LE+JSON framing itself — correct.
 */

const HOST_NAME = "com.opencodeinchrome.bridge"
const PING_PERIOD_MIN = 0.5 // 30 s — below the MV3 idle timeout

let port = null
let lastStatus = {
  type: "disconnected", // disconnected | connecting | connected | host_missing
  hostVersion: null,
  mcpClients: 0,
  extensionConnected: false,
}

function setStatus(patch) {
  lastStatus = { ...lastStatus, ...patch, updatedAt: new Date().toISOString() }
  chrome.storage.local.set({ bridgeStatus: lastStatus }).catch(() => {})
  chrome.runtime.sendMessage({ kind: "bridgeStatus", status: lastStatus }).catch(() => {})
}

// ── Native messaging port ────────────────────────────────────────────────────

function connectHost() {
  if (port) return
  setStatus({ type: "connecting" })

  try {
    port = chrome.runtime.connectNative(HOST_NAME)
  } catch (err) {
    port = null
    setStatus({ type: "host_missing", detail: String(err) })
    return // the keepalive alarm retries
  }

  // Chrome delivers each host message as an already-parsed object.
  port.onMessage.addListener((msg) => handleHostMessage(msg))

  port.onDisconnect.addListener(() => {
    const detail = chrome.runtime.lastError?.message ?? "host exited"
    port = null
    setStatus({ type: "disconnected", detail })
    scheduleReconnect()
  })

  // Handshake: Chrome frames `{type:"ping"}` for us; host replies pong and marks
  // extensionConnected=true, which is what makes tool calls routable.
  port.postMessage({ type: "ping" })
  port.postMessage({ type: "get_status" })
}

function pingHost() {
  if (port) port.postMessage({ type: "ping" })
}

function handleHostMessage(msg) {
  switch (msg?.type) {
    case "pong":
      setStatus({ type: "connected" })
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
      if (port) port.postMessage({ type: "get_status" }) // refresh mcpClients count
      break
    case "tool_request":
      // Fase 1 (M1) implements the dispatcher; answer deterministically meanwhile.
      port?.postMessage({
        type: "tool_response",
        id: msg.id,
        ok: false,
        error: { message: "browser tools land in Fase 1 (M1) — connection is healthy" },
      })
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
  // setTimeout does not survive SW suspension — treat it as best-effort; the
  // keepalive alarm is the durable retry path.
  const delay = Math.min(30_000, 500 * 2 ** reconnectAttempts++)
  setTimeout(() => connectHost(), delay)
}

chrome.alarms.create("keepalive", { periodInMinutes: PING_PERIOD_MIN })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "keepalive") return
  connectHost() // no-ops if the port is alive; respawns the host otherwise
  pingHost()
})

// ── Side panel messaging ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === "getStatus") {
    sendResponse(lastStatus)
  }
  return false
})

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

chrome.runtime.onInstalled.addListener(() => connectHost())
chrome.runtime.onStartup.addListener(() => connectHost())

// The SW may be revived without install/startup events (alarm, message) — the
// top-level run is itself a wake: connect immediately.
connectHost()
