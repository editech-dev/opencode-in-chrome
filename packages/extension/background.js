/**
 * OpenCode in Chrome — service worker (M1-lite).
 *
 * Layers:
 *  1. Native messaging port to `com.opencodeinchrome.bridge` (Chrome frames for us).
 *  2. Tool dispatcher: tool_request → handler → tool_response (correlation id,
 *     session scope, tab-group isolation — invariant I1).
 *  3. Tab-group manager: one Chrome tab group per agent session, persisted in
 *     chrome.storage.local, stale-entry detection on every call.
 *  4. Keep-alive (alarms) + reconnection backoff.
 *
 * Rules mirrored from @opencode-in-chrome/core (tab-rules): the pure logic is
 * unit-tested there; this file adds the chrome.* glue. Consolidation into one
 * import happens with the WXT bundler (TASKS T10).
 */

const HOST_NAME = "com.opencodeinchrome.bridge"
const PING_PERIOD_MIN = 0.5
const NAV_WAIT_TIMEOUT_MS = 15_000

// ── State ────────────────────────────────────────────────────────────────────

let port = null
let lastStatus = {
  type: "disconnected",
  hostVersion: null,
  mcpClients: 0,
  extensionConnected: false,
}

/** sessionId → { tabGroupId, windowId } */
const sessionGroups = new Map()

async function loadSessionGroups() {
  const { sessionGroupsSnapshot } = await chrome.storage.local.get("sessionGroupsSnapshot").catch(() => ({}))
  for (const [k, v] of Object.entries(sessionGroupsSnapshot ?? {})) sessionGroups.set(k, v)
}

async function saveSessionGroups() {
  const snapshot = Object.fromEntries(sessionGroups)
  await chrome.storage.local.set({ sessionGroupsSnapshot: snapshot }).catch(() => {})
}

function setStatus(patch) {
  lastStatus = { ...lastStatus, ...patch, updatedAt: new Date().toISOString() }
  chrome.storage.local.set({ bridgeStatus: lastStatus }).catch(() => {})
  chrome.runtime.sendMessage({ kind: "bridgeStatus", status: lastStatus }).catch(() => {})
}

// ── Pure rules (mirrored from core/tab-rules — see header note) ─────────────

function isWebViewUrl(url) {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

const noGroupError = (tool) => `${tool}: no tab group for this session yet — call tabs_context with createIfEmpty:true first`
const foreignTabError = (tabId, tool) =>
  `${tool}: tab ${tabId} is outside this session's tab group — isolation is enforced`
const urlSchemeError = (url) => `navigate: scheme refused "${url}" — only http/https through agent tools`

// ── Tab-group manager ────────────────────────────────────────────────────────

async function liveGroupIds() {
  const groups = await chrome.tabGroups.query({})
  return groups.map((g) => g.id)
}

async function ensureGroup(sessionId, createIfEmpty) {
  const entry = sessionGroups.get(sessionId)
  const alive = await liveGroupIds()

  if (entry && alive.includes(entry.tabGroupId)) return entry

  if (!createIfEmpty) {
    if (entry) {
      sessionGroups.delete(sessionId)
      await saveSessionGroups()
    }
    throw new Error(noGroupError("tabs_context"))
  }

  const win = await chrome.windows.create({ focused: false })
  const groupId = await chrome.tabs.group({ tabIds: [win.tabs[0].id], createProperties: { windowId: win.id } })
  const fresh = { tabGroupId: groupId, windowId: win.id }
  sessionGroups.set(sessionId, fresh)
  await saveSessionGroups()
  return fresh
}

async function groupTabs(entry) {
  return chrome.tabs.query({ groupId: entry.tabGroupId })
}

async function requireMemberTab(args, entry, tool) {
  if (args.tabId !== undefined) {
    let tab
    try {
      tab = await chrome.tabs.get(args.tabId)
    } catch {
      throw new Error(foreignTabError(args.tabId, tool))
    }
    if (tab.groupId !== entry.tabGroupId) throw new Error(foreignTabError(args.tabId, tool))
    return tab
  }
  const tabs = await groupTabs(entry)
  const active = tabs.find((t) => t.active) ?? tabs[0]
  if (!active) throw new Error(`${tool}: the session's tab group is empty — call tabs_create first`)
  return active
}

async function forgetGroupIfGone(sessionId) {
  const entry = sessionGroups.get(sessionId)
  if (!entry) return
  if (!(await liveGroupIds()).includes(entry.tabGroupId)) {
    sessionGroups.delete(sessionId)
    await saveSessionGroups()
  }
}

// ── Tool handlers (M1-lite: 4 tools) ─────────────────────────────────────────

const tools = {
  async tabs_context(args, scope) {
    // Must be the first call of a session; creates the group on demand (I1 base).
    const entry = await ensureGroup(scope.sessionId, args.createIfEmpty === true)
    const tabs = await groupTabs(entry)
    await forgetGroupIfGone(scope.sessionId)
    return {
      tabGroupId: entry.tabGroupId,
      windowId: entry.windowId,
      tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
    }
  },

  async tabs_create(args, scope) {
    const entry = await ensureGroup(scope.sessionId, false)
    const url = args.url ?? "https://example.com"
    if (!isWebViewUrl(url)) throw new Error(urlSchemeError(url))
    const tab = await chrome.tabs.create({ url, active: args.active !== false, windowId: entry.windowId })
    await chrome.tabs.group({ tabIds: [tab.id], groupId: entry.tabGroupId })
    return { tabId: tab.id, url, tabGroupId: entry.tabGroupId }
  },

  async tabs_close(args, scope) {
    const entry = await ensureGroup(scope.sessionId, false)
    const tab = await requireMemberTab(args, entry, "tabs_close")
    await chrome.tabs.remove(tab.id)
    await forgetGroupIfGone(scope.sessionId) // last tab closed ⇒ group goes away
    return { closed: tab.id }
  },

  async navigate(args, scope) {
    const entry = await ensureGroup(scope.sessionId, false)
    const tab = await requireMemberTab(args, entry, "navigate")
    const url = String(args.url ?? "")
    if (!isWebViewUrl(url)) throw new Error(urlSchemeError(url))
    await chrome.tabs.update(tab.id, { url })
    await waitForLoad(tab.id)
    const fresh = await chrome.tabs.get(tab.id)
    return { tabId: tab.id, url: fresh.url, title: fresh.title, status: "complete" }
  },
}

function waitForLoad(tabId, timeoutMs = NAV_WAIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve("timeout") // navigation still useful; the model sees the timeout
    }, timeoutMs)
    function listener(updatedId, info) {
      if (updatedId !== tabId || info.status !== "complete") return
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve("complete")
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

async function dispatchTool(msg) {
  const scope = { sessionId: msg.sessionScope?.sessionId ?? "local", tabGroupId: msg.sessionScope?.tabGroupId }
  const tool = msg.tool
  const handler = tools[tool]
  if (!handler) {
    port?.postMessage({
      type: "tool_response",
      id: msg.id,
      ok: false,
      error: { message: `unknown tool "${tool}" — available: ${Object.keys(tools).join(", ")}` },
    })
    return
  }
  try {
    const result = await handler(msg.args ?? {}, scope)
    port?.postMessage({
      type: "tool_response",
      id: msg.id,
      ok: true,
      result: { content: [{ type: "text", text: JSON.stringify(result) }] },
    })
  } catch (err) {
    port?.postMessage({
      type: "tool_response",
      id: msg.id,
      ok: false,
      error: { message: String(err?.message ?? err) },
    })
  }
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
    return
  }
  port.onMessage.addListener((msg) => handleHostMessage(msg))
  port.onDisconnect.addListener(() => {
    const detail = chrome.runtime.lastError?.message ?? "host exited"
    port = null
    setStatus({ type: "disconnected", detail })
    scheduleReconnect()
  })
  port.postMessage({ type: "ping" })
  port.postMessage({ type: "get_status" })
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
      if (port) port.postMessage({ type: "get_status" })
      break
    case "tool_request":
      dispatchTool(msg)
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
  setTimeout(() => connectHost(), delay)
}

chrome.alarms.create("keepalive", { periodInMinutes: PING_PERIOD_MIN })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "keepalive") return
  connectHost()
  if (port) port.postMessage({ type: "ping" })
})

// ── Side panel messaging ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === "getStatus") sendResponse(lastStatus)
  return false
})

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

chrome.runtime.onInstalled.addListener(() => connectHost())
chrome.runtime.onStartup.addListener(() => connectHost())

;(async () => {
  await loadSessionGroups()
  connectHost()
})()
