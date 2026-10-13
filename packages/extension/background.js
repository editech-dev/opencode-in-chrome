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

// ── Secret redaction (mirrored from shared/src/redact.ts — TS consolidation at T10/WXT) ──

const REDACTED = "[REDACTED]"
const KEY_TOKEN =
  /(?:^|[._\-\s])(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|auth(?:orization(?:[._-]token)?)?|bearer|credentials?|session[_-]?id|cookie)(?:$|[._\-\s])/i

function redactLineJs(line) {
  const sep = /[:=]/.exec(line)
  if (!sep) return line
  const key = line.slice(0, sep.index).trim()
  if (!key || !KEY_TOKEN.test(key)) return line
  const rest = line.slice(sep.index + 1)
  if (!rest.trim()) return line
  const indent = /^(?:\s*[-*]?\s*)/.exec(line)?.[0] ?? ""
  return `${indent}${key}: ${REDACTED}`
}

function redactAll(text) {
  const jsonPair =
    /("(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|auth(?:orization(?:[._-]token)?)?|bearer|credentials?|session[_-]?id|cookie)[\w.\-_]*"\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi
  const afterJson = text.replace(jsonPair, `$1"${REDACTED.slice(1, -1)}"`)
  return afterJson.split("\n").map(redactLineJs).join("\n")
}

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

// ── Computer tool internals (CDP) ────────────────────────────────────────────

const MAX_SHORT = 30_000

function pngSize(b64) {
  // IHDR: width at byte 16, height at byte 20 (big-endian) — no Buffer in MV3.
  const bin = atob(b64)
  const be = (i) => (bin.charCodeAt(i) << 24) >>> 0 + 0
  const u32 = (i) =>
    ((bin.charCodeAt(i) & 255) * 2 ** 24 + (bin.charCodeAt(i + 1) << 16) + (bin.charCodeAt(i + 2) << 8) + (bin.charCodeAt(i + 3) & 255))
  return { imgW: u32(16), imgH: u32(20), _unused: be(0) }
}

async function withDebuggerSession(tabId, fn) {
  await chrome.debugger.attach({ tabId }, "1.3")
  try {
    const send = async (command, params) => {
      const res = await chrome.debugger.sendCommand({ tabId }, command, params)
      return res?.result ?? res
    }
    return await fn(send)
  } finally {
    chrome.debugger.detach({ tabId }).catch(() => {})
  }
}

/** tabId → {imgW, imgH} of the last screenshot — coordinate space reference. */
const screenshotContext = new Map()

/** Mirrors core/key-spec.ts (T10 consolidation). */
const NAMED_KEYS = {
  Enter: { vk: 13, key: "Enter", code: "Enter", text: "\r" },
  Return: { vk: 13, key: "Enter", code: "Enter", text: "\r" },
  Tab: { vk: 9, key: "Tab", code: "Tab" },
  Escape: { vk: 27, key: "Escape", code: "Escape" },
  Esc: { vk: 27, key: "Escape", code: "Escape" },
  Backspace: { vk: 8, key: "Backspace", code: "Backspace" },
  Delete: { vk: 46, key: "Delete", code: "Delete" },
  Space: { vk: 32, key: " ", code: "Space", text: " " },
  PageUp: { vk: 33, key: "PageUp", code: "PageUp" },
  PageDown: { vk: 34, key: "PageDown", code: "PageDown" },
  End: { vk: 35, key: "End", code: "End" },
  Home: { vk: 36, key: "Home", code: "Home" },
  ArrowLeft: { vk: 37, key: "ArrowLeft", code: "ArrowLeft" },
  ArrowUp: { vk: 38, key: "ArrowUp", code: "ArrowUp" },
  ArrowRight: { vk: 39, key: "ArrowRight", code: "ArrowRight" },
  ArrowDown: { vk: 40, key: "ArrowDown", code: "ArrowDown" },
}

function keyPressJs(spec) {
  const modifiers =
    (/ctrl/i.test(spec) ? 2 : 0) | (/alt/i.test(spec) ? 1 : 0) | (/meta|cmd/i.test(spec) ? 4 : 0) | (/shift/i.test(spec) ? 8 : 0)
  const tokens = spec.split(/[+-]/).filter(Boolean)
  let key = tokens.at(-1) ?? spec
  if (key.length === 0) key = spec === "+" ? "+" : key
  let named = NAMED_KEYS[key] ?? NAMED_KEYS[key.toLowerCase()] ?? (key === "+" ? { vk: 187, key: "+", code: "Equal", text: "+" } : undefined)
  if (!named) {
    if (key.length === 1 && /[a-z0-9]/i.test(key)) {
      const upper = key.toUpperCase()
      named =
        upper >= "A" && upper <= "Z"
          ? { vk: upper.charCodeAt(0), key: key.toLowerCase(), code: `Key${upper}`, text: modifiers & 8 ? upper : key }
          : { vk: upper.charCodeAt(0), key, code: `Digit${key}`, text: key }
    } else {
      throw new Error(`computer: unsupported key "${spec}" — named keys or single chars only`)
    }
  }
  const base = { key: named.key, code: named.code, windowsVirtualKeyCode: named.vk, modifiers }
  const text = modifiers & (1 | 2 | 4) ? undefined : named.text
  return {
    down: { ...base, type: text ? "keyDown" : "rawKeyDown", ...(text ? { text } : {}) },
    up: { ...base, type: "keyUp" },
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

const MAX_TEXT_CHARS = 50_000

async function withDebugger(tabId, command, params) {
  await chrome.debugger.attach({ tabId }, "1.3")
  try {
    return await chrome.debugger.sendCommand({ tabId }, command, params)
  } finally {
    chrome.debugger.detach({ tabId }).catch(() => {})
  }
}

const tools = {
  async get_page_text(args, scope) {
    const entry = await ensureGroup(scope.sessionId, false)
    const tab = await requireMemberTab(args, entry, "get_page_text")
    const res = await withDebugger(tab.id, "Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : \"\"",
      returnByValue: true,
    })
    const raw = typeof res?.result?.value === "string" ? res.result.value : ""
    const clean = redactAll(raw)
    const truncated = clean.length > MAX_TEXT_CHARS
    return {
      tabId: tab.id,
      url: tab.url,
      chars: clean.length,
      truncated,
      text: truncated ? clean.slice(0, MAX_TEXT_CHARS) : clean,
    }
  },

  async computer(args, scope) {
    const entry = await ensureGroup(scope.sessionId, false)
    const tab = await requireMemberTab(args, entry, "computer")
    const action = String(args.action ?? "")

    return withDebuggerSession(tab.id, async (send) => {
      if (action === "screenshot") {
        const png = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })
        const { imgW, imgH } = pngSize(png.data)
        screenshotContext.set(tab.id, { imgW, imgH })
        return {
          content: [
            { type: "image", data: png.data, mimeType: "image/png" },
            {
              type: "text",
              text: JSON.stringify({
                tabId: tab.id,
                width: imgW,
                height: imgH,
                note: "coordinates for computer actions refer to THIS screenshot until the next one",
              }),
            },
          ],
        }
      }

      // Coordinate-based actions scale from the last screenshot's space to CSS px.
      const metrics = await send("Page.getLayoutMetrics", {})
      const css = metrics.cssVisualViewport ?? metrics.layoutViewport ?? {}
      const cssW = css.width || 1280
      const cssH = css.height || 800
      const scaleFor = (x, y) => {
        const sc = screenshotContext.get(tab.id)
        if (!sc || !sc.imgW || !sc.imgH || !cssW || !cssH) return { x, y }
        return { x: Math.round((x * cssW) / sc.imgW), y: Math.round((y * cssH) / sc.imgH) }
      }
      const mouse = (o) => send("Input.dispatchMouseEvent", o)
      const clamp = (p) => ({ x: Math.max(0, Math.min(cssW, Math.round(p.x))), y: Math.max(0, Math.min(cssH, Math.round(p.y))) })

      switch (action) {
        case "left_click":
        case "right_click":
        case "double_click":
        case "triple_click":
        case "hover": {
          if (!args.coordinates) throw new Error(`computer: ${action} requires coordinates {x,y}`)
          const p = clamp(scaleFor(args.coordinates.x, args.coordinates.y))
          const clickCount = { left_click: 1, right_click: 1, double_click: 2, triple_click: 3, hover: 0 }[action] ?? 0
          await mouse({ type: "mouseMoved", x: p.x, y: p.y })
          if (clickCount > 0) {
            await mouse({ type: "mousePressed", x: p.x, y: p.y, button: action === "right_click" ? "right" : "left", clickCount, buttons: 1 })
            await mouse({ type: "mouseReleased", x: p.x, y: p.y, button: action === "right_click" ? "right" : "left", clickCount, buttons: 0 })
          }
          return { done: true, action, x: p.x, y: p.y }
        }

        case "left_click_drag": {
          if (!args.coordinates) throw new Error("computer: left_click_drag requires coordinates {x,y} (drag end)")
          const from = clamp(scaleFor(args.startCoordinates?.x ?? args.coordinates.x, args.startCoordinates?.y ?? args.coordinates.y))
          const to = clamp(scaleFor(args.coordinates.x, args.coordinates.y))
          const steps = 6
          await mouse({ type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1, buttons: 1 })
          for (let i = 1; i <= steps; i++) {
            await mouse({
              type: "mouseMoved",
              x: Math.round(from.x + ((to.x - from.x) * i) / steps),
              y: Math.round(from.y + ((to.y - from.y) * i) / steps),
              buttons: 1,
            })
          }
          await mouse({ type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1, buttons: 0 })
          return { done: true, action, from, to }
        }

        case "scroll": {
          const p = clamp(scaleFor(args.coordinates?.x ?? cssW / 2, args.coordinates?.y ?? cssH / 2))
          const amount = Math.max(1, Math.min(10, args.scrollAmount ?? 3))
          const dir = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[args.scrollDirection ?? "down"] ?? [0, 1]
          await mouse({ type: "mouseWheel", x: p.x, y: p.y, deltaX: dir[0] * amount * 240, deltaY: dir[1] * amount * 240 })
          return { done: true, action: "scroll", x: p.x, y: p.y }
        }

        case "type": {
          const text = String(args.text ?? "")
          if (!text) throw new Error("computer: type requires text")
          for (let i = 0; i < text.length; i += 4_000) {
            await send("Input.insertText", { text: text.slice(i, i + 4_000) })
          }
          return { done: true, action: "type", chars: text.length }
        }

        case "key": {
          const spec = String(args.key ?? "")
          const keys = spec.split(/\s+/).filter(Boolean)
          if (keys.length === 0) throw new Error("computer: key requires a spec like \"Enter\" or \"ctrl+a\"")
          for (const k of keys) {
            const press = keyPressJs(k)
            await send("Input.dispatchKeyEvent", press.down)
            await send("Input.dispatchKeyEvent", press.up)
          }
          return { done: true, action: "key", keys }
        }

        case "wait": {
          const ms = Math.min(MAX_SHORT, args.durationMs ?? 500)
          await sleepMs(ms)
          return { done: true, action: "wait", ms }
        }

        default:
          throw new Error(
            `computer: unknown action "${action}" — available: screenshot, left_click, right_click, double_click, triple_click, left_click_drag, scroll, type, key, hover, wait`,
          )
      }
    })
  },

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
    const content = result && Array.isArray(result.content) ? result.content : [{ type: "text", text: JSON.stringify(result) }]
    port?.postMessage({
      type: "tool_response",
      id: msg.id,
      ok: true,
      result: { content },
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
