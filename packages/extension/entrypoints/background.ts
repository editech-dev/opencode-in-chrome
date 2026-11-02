/**
 * OpenCode in Chrome — background (WXT): service worker MV3.
 *
 * Layers:
 *  1. Native messaging port to `com.opencodeinchrome.bridge` (Chrome frames for us).
 *  2. Tool dispatcher: tool_request → handler → tool_response (correlation id,
 *     session scope, tab-group isolation — invariant I1).
 *  3. Tab-group manager: one Chrome tab group per agent session, persisted in
 *     storage, stale-entry detection on every call.
 *  4. Keep-alive (alarms) + reconnection backoff.
 *
 * Pure rules (URL scheme, membership, error texts) live in
 * @opencode-in-chrome/core/tab-rules; key specs in core/key-spec; secret
 * redaction in @opencode-in-chrome/shared/redact — imported directly now that
 * the extension is bundled (T10 retired the mirrored copies).
 */
import { browser } from "wxt/browser"
import { defineBackground } from "wxt/utils/define-background"
import { redactAll } from "../../shared/src/redact"
import {
  foreignTabError,
  isWebViewUrl,
  noGroupError,
  shouldEnablePanel,
  urlSchemeError,
} from "../../core/src/tab-rules"
import { keyPressEvent } from "../../core/src/key-spec"

// Tool-arg contracts are specified in specs/04 (zod lands with the MCP layer,
// T12) and validated upstream by the wire layer; until then the dispatcher
// treats args as dynamic and leans on typed refusals for bad shapes.
type Args = any
type Scope = { sessionId: string; tabGroupId?: number }
type HostMessage = any

/** Minimal shape the dispatcher relies on; real zod contracts land with T12. */
type TabLike = { id: number; url?: string; title?: string | null; active: boolean; groupId?: number }

/** CDP replies are dynamic by nature (protocol-defined, not TS-defined). */
type CdpReply = any
/** Single CDP command against the attached debugger target. */
type CdpSender = (command: string, params?: Record<string, unknown>) => Promise<CdpReply>

export default defineBackground(() => {
  const HOST_NAME = "com.opencodeinchrome.bridge"
  const PING_PERIOD_MIN = 0.5
  const NAV_WAIT_TIMEOUT_MS = 15_000
  const MAX_TEXT_CHARS = 50_000
  const MAX_SHORT = 30_000

  // ── State ──────────────────────────────────────────────────────────────────

  let port: ReturnType<typeof browser.runtime.connectNative> | null = null
  let lastStatus = {
    type: "disconnected",
    hostVersion: null as string | null,
    mcpClients: 0,
    extensionConnected: false,
    scratchDir: "",
  }

  /** sessionId → { tabGroupId, windowId } */
  const sessionGroups = new Map<string, { tabGroupId: number; windowId: number }>()
  /** windowId → the ONE OpenCode group this window hosts (panel flow — Claude parity). */
  const windowGroups = new Map<number, { tabGroupId: number; sessionId: string }>()
  /** windowId → OpenCode group whose side panel is visible (specs/08). */
  const panelScopeByWindow = new Map<number, { groupId: number; sessionId: string }>()
  /** windowId → tab where the panel was opened (ephemeral; survives until SW restart). */
  const panelHostByWindow = new Map<number, number>()

  const PANEL_PATH = "sidepanel.html"

  async function loadPanelScopes() {
    const { panelScopeSnapshot } = (await browser.storage.session
      .get("panelScopeSnapshot")
      .catch(() => ({}))) as { panelScopeSnapshot?: Record<string, { groupId: number; sessionId: string }> }
    for (const [k, v] of Object.entries(panelScopeSnapshot ?? {})) panelScopeByWindow.set(Number(k), v)
  }

  async function savePanelScopes() {
    const snapshot = Object.fromEntries([...panelScopeByWindow.entries()].map(([k, v]) => [String(k), v]))
    await browser.storage.session.set({ panelScopeSnapshot: snapshot } as never).catch(() => {})
  }

  async function loadSessionGroups() {
    const { sessionGroupsSnapshot, windowGroupsSnapshot } = await browser.storage.local
      .get(["sessionGroupsSnapshot", "windowGroupsSnapshot"])
      .catch(() => ({}) as Record<string, never>)
    for (const [k, v] of Object.entries(sessionGroupsSnapshot ?? {})) sessionGroups.set(k, v as never)
    for (const [k, v] of Object.entries(windowGroupsSnapshot ?? {})) windowGroups.set(Number(k), v as never)
  }

  async function saveSessionGroups() {
    const snapshot = Object.fromEntries(sessionGroups)
    const windowSnapshot = Object.fromEntries([...windowGroups.entries()].map(([k, v]) => [String(k), v]))
    await browser.storage.local
      .set({ sessionGroupsSnapshot: snapshot, windowGroupsSnapshot: windowSnapshot } as never)
      .catch(() => {})
  }

  function setStatus(patch: Partial<typeof lastStatus>) {
    lastStatus = { ...lastStatus, ...patch, updatedAt: new Date().toISOString() } as never
    browser.storage.local.set({ bridgeStatus: lastStatus } as never).catch(() => {})
    browser.runtime
      .sendMessage({ kind: "bridgeStatus", status: lastStatus })
      .catch(() => {})
  }

  // ── Tab-group manager ──────────────────────────────────────────────────────

  async function liveGroupIds() {
    const groups = await browser.tabGroups.query({})
    return groups.map((g) => g.id)
  }

  async function ensureGroup(
    sessionId: string,
    createIfEmpty: boolean,
    opts?: { windowId?: number; adoptable?: boolean; hostTabId?: number },
  ) {
    const entry = sessionGroups.get(sessionId)
    const alive = await liveGroupIds()

    if (entry && alive.includes(entry.tabGroupId)) {
      // The session already owns a group: if the panel was opened on another tab
      // of the same window, move that host tab into the group so the scoped
      // panel stays visible on its own tab (specs/08).
      if (opts?.adoptable && opts.hostTabId !== undefined && opts.windowId === entry.windowId) {
        const host = await browser.tabs.get(opts.hostTabId).catch(() => null)
        if (host?.id !== undefined && host.windowId === entry.windowId && !host.pinned && host.groupId !== entry.tabGroupId) {
          await browser.tabs.group({ tabIds: [host.id], groupId: entry.tabGroupId }).catch(() => {})
        }
        panelScopeByWindow.set(entry.windowId, { groupId: entry.tabGroupId, sessionId })
        windowGroups.set(entry.windowId, { tabGroupId: entry.tabGroupId, sessionId })
        await savePanelScopes()
        await saveSessionGroups()
        void syncPanelScope(entry.windowId)
        browser.runtime.sendMessage({ kind: "panelScope", windowId: entry.windowId, sessionId }).catch(() => {})
      }
      return entry
    }

    // T-D1 (resuelto por pedido del usuario, 17-oct): el grupo vive en la
    // ventana ACTUAL — el grupo es la frontera de aislamiento, no la ventana
    // (paridad Claude in Chrome). Origen del windowId: el panel que llamó
    // > última ventana con foco.
    let target = opts?.windowId
    if (target === undefined) {
      const last = await browser.windows
        .getLastFocused({ populate: false })
        .catch(() => null as { id?: number } | null)
      target = last?.id
    }

    // ── Modo B unification (27-oct: CINTURÓN DE SEGURIDAD, no cimiento) ─────────
    // Root cause del bug de multiplicación: identidad dual ses vs proceso MCP.
    // RESUELTO EN LA FUENTE (contrato #8): el tools/call real ya trae
    // _meta["ai.opencode/sessionID"] → las tool calls llegan con ses_ REAL y
    // montan en el mapping del propio flujo del panel. Este ride queda como
    // fallback para callers SIN _meta (OpenCode viejo, probes desnudos).
    // Tool calls made by the panel chat's agent carry the MCP PROCESS id
    // ("mcp-…"), stable per OpenCode SERVER process, not per session — so
    // creating a group for it would multiply groups on every respawn and
    // split the panel chat (its seed group) from its own tool calls. When a
    // panel group exists in this window, the tool call RIDES IT dynamically.
    if (sessionId.startsWith("mcp-") && target !== undefined) {
      const wg = windowGroups.get(target)
      if (wg && alive.includes(wg.tabGroupId)) {
        return { tabGroupId: wg.tabGroupId, windowId: target }
      }
      // No panel group here → own group for this MCP process (Modo A CLI).
    }

    if (!createIfEmpty) {
      if (entry) {
        sessionGroups.delete(sessionId)
        await saveSessionGroups()
      }
      throw new Error(noGroupError("tabs_context"))
    }

    if (target === undefined) {
      // Chrome sin ventanas visibles (arranque exótico): el camino viejo.
      const win = await browser.windows.create({ focused: false })
      if (!win) throw new Error("tabs_context: chrome refused to open the session window")
      const seedTabId = win.tabs?.[0]?.id
      if (seedTabId === undefined || win.id === undefined) {
        throw new Error("tabs_context: chrome did not return a window with a seed tab")
      }
      const groupId = await browser.tabs.group({ tabIds: [seedTabId], createProperties: { windowId: win.id } })
      const fresh = { tabGroupId: groupId, windowId: win.id }
      sessionGroups.set(sessionId, fresh)
      await saveSessionGroups()
      await brandGroup(groupId)
      return fresh
    }

    // ── Panel flow: ONE OpenCode group per window (Claude parity) ──────────
    // Invariant: a Chrome group DIES when its last tab dies. So "clear the
    // context" must never empty it: keep ONE survivor tab, close the rest,
    // navigate the survivor to the user's current page ("se lleva la página").
    // That keeps the same groupId alive forever — ＋ never multiplies groups.
    let reuseGroupId: number | undefined
    if (opts?.adoptable) {
      const previous = windowGroups.get(target)
      if (previous && previous.sessionId !== sessionId && alive.includes(previous.tabGroupId)) {
        reuseGroupId = previous.tabGroupId
        sessionGroups.delete(previous.sessionId)
      } else {
        // Orphaned OpenCode group in this window (built before windowGroups
        // existed, or the SW lost its state): adopt by branding, if unclaimed.
        const windowGroupsAll = await browser.tabGroups.query({ windowId: target }).catch(() => [])
        const claimed = new Set([...sessionGroups.values()].map((e) => e.tabGroupId))
        const orphan = windowGroupsAll.find((g) => g.title === "OpenCode" && !claimed.has(g.id))
        if (orphan) reuseGroupId = orphan.id
      }
    }

    let seedTabId: number | undefined
    if (reuseGroupId !== undefined) {
      // Adopt: keep one survivor, close the rest, navigate it to the current page.
      const tabs = await browser.tabs.query({ groupId: reuseGroupId }).catch(() => [])
      const ids = tabs.map((t) => t.id).filter((id): id is number => id !== undefined)
      const survivor = ids[0]
      const rest = ids.slice(1)
      if (rest.length > 0) await browser.tabs.remove(rest).catch(() => {})
      if (survivor !== undefined) {
        const activeTab = (await browser.tabs.query({ windowId: target, active: true }).catch(() => []))[0]
        if (activeTab?.url && /^https?:/.test(activeTab.url)) {
          await browser.tabs.update(survivor, { url: activeTab.url, active: false }).catch(() => {})
        } else {
          await browser.tabs.update(survivor, { active: false }).catch(() => {})
        }
        seedTabId = survivor
      }
      if (seedTabId === undefined) {
        // The group died anyway (race) — fall through to the fresh path.
        reuseGroupId = undefined
      }
    }

    if (reuseGroupId === undefined) {
      // Panel flow: the tab where the user opened the panel is the seed — it
      // must stay INSIDE the group or the scoping would hide the panel (specs/08).
      if (opts?.hostTabId !== undefined) {
        const host = await browser.tabs.get(opts.hostTabId).catch(() => null)
        if (host?.id !== undefined && host.windowId === target && !host.pinned) seedTabId = host.id
      }
      if (seedTabId === undefined) {
        // Fresh: duplicate the active tab (carries the page), group it anew.
        const activeTab = (await browser.tabs.query({ windowId: target, active: true }).catch(() => []))[0]
        if (activeTab?.id !== undefined) {
          const dup = await browser.tabs.duplicate(activeTab.id).catch(() => null)
          seedTabId = dup?.id
          if (seedTabId !== undefined) await browser.tabs.update(seedTabId, { active: false }).catch(() => {})
        }
      }
      if (seedTabId === undefined) {
        const made = await browser.tabs.create({ windowId: target, active: false }).catch(() => null)
        seedTabId = made?.id
      }
      if (seedTabId === undefined) throw new Error("tabs_context: chrome did not return a seed tab")
    }

    // Adoption keeps the group's survivor but still needs the panel host tab in
    // the group, otherwise the panel would be scoped out of its own tab.
    if (reuseGroupId !== undefined && opts?.hostTabId !== undefined) {
      const host = await browser.tabs.get(opts.hostTabId).catch(() => null)
      if (host?.id !== undefined && host.windowId === target && !host.pinned) {
        await browser.tabs.group({ tabIds: [host.id], groupId: reuseGroupId }).catch(() => {})
      }
    }

    if (seedTabId === undefined) throw new Error("tabs_context: no seed tab survived adoption")
    let groupId
    if (reuseGroupId !== undefined) {
      groupId = browser.tabs.group({ tabIds: [seedTabId], groupId: reuseGroupId })
    } else {
      groupId = browser.tabs.group({ tabIds: [seedTabId], createProperties: { windowId: target } })
    }
    const gid = await groupId
    const fresh = { tabGroupId: gid, windowId: target }
    sessionGroups.set(sessionId, fresh)
    if (opts?.adoptable) {
      windowGroups.set(target, { tabGroupId: gid, sessionId })
      panelScopeByWindow.set(target, { groupId: gid, sessionId })
      await savePanelScopes()
      void syncPanelScope(target)
      // Other panel instances in the same window restore the same chat.
      browser.runtime.sendMessage({ kind: "panelScope", windowId: target, sessionId }).catch(() => {})
    }
    await saveSessionGroups()
    await brandGroup(gid)
    return fresh
  }

  /** Names + colors the group so the user sees whose tabs are whose. */
  async function brandGroup(groupId: number): Promise<void> {
    try {
      await browser.tabGroups.update(groupId, { color: "orange", title: "OpenCode" })
    } catch {
      // cosmetic only
    }
  }

  // ── Side-panel scoping (specs/08) ──────────────────────────────────────────

  /** Enables the panel only on tabs of the window's OpenCode group (or the host tab pre-group). */
  async function syncPanelScope(windowId: number): Promise<void> {
    const scope = panelScopeByWindow.get(windowId)
    const hostTabId = panelHostByWindow.get(windowId)
    const tabs = await browser.tabs.query({ windowId }).catch(() => [])
    await Promise.all(
      tabs.map((tab) => {
        if (tab.id === undefined) return Promise.resolve()
        const enabled = shouldEnablePanel(tab, scope, hostTabId)
        return browser.sidePanel.setOptions({ tabId: tab.id, path: PANEL_PATH, enabled }).catch(() => {})
      }),
    )
  }

  async function syncPanelTab(tabId: number): Promise<void> {
    const tab = await browser.tabs.get(tabId).catch(() => null)
    if (!tab || tab.id === undefined) return
    const scope = panelScopeByWindow.get(tab.windowId)
    const hostTabId = panelHostByWindow.get(tab.windowId)
    const enabled = shouldEnablePanel(tab, scope, hostTabId)
    await browser.sidePanel.setOptions({ tabId: tab.id, path: PANEL_PATH, enabled }).catch(() => {})
  }

  async function initPanelScoping(): Promise<void> {
    // No global default panel: the manifest hook removes side_panel.default_path.
    await browser.sidePanel.setOptions({ enabled: false }).catch(() => {})
    await browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})
    const windows = await browser.windows.getAll({ populate: true }).catch(() => [])
    const live = new Set(windows.map((w) => w.id))
    for (const windowId of [...panelScopeByWindow.keys()]) {
      if (!live.has(windowId)) {
        panelScopeByWindow.delete(windowId)
        panelHostByWindow.delete(windowId)
      }
    }
    await savePanelScopes()
    for (const win of windows) {
      if (win.id !== undefined) await syncPanelScope(win.id)
    }
  }

  async function groupTabs(entry: { tabGroupId: number }) {
    return browser.tabs.query({ groupId: entry.tabGroupId })
  }

  async function requireMemberTab(
    args: Args,
    entry: { tabGroupId: number },
    tool: string,
  ): Promise<TabLike> {
    if (args.tabId !== undefined) {
      let tab: TabLike | undefined
      try {
        tab = (await browser.tabs.get(args.tabId)) as TabLike
      } catch {
        throw new Error(foreignTabError(args.tabId, tool))
      }
      if (tab.groupId !== entry.tabGroupId) throw new Error(foreignTabError(args.tabId, tool))
      return tab
    }
    const tabs = (await groupTabs(entry)) as TabLike[]
    const active = tabs.find((t) => t.active) ?? tabs[0]
    if (!active) throw new Error(`${tool}: the session's tab group is empty — call tabs_create first`)
    return active
  }

  async function forgetGroupIfGone(sessionId: string) {
    const entry = sessionGroups.get(sessionId)
    if (!entry) return
    if (!(await liveGroupIds()).includes(entry.tabGroupId)) {
      sessionGroups.delete(sessionId)
      await saveSessionGroups()
    }
  }

  // ── Computer tool internals (CDP) ──────────────────────────────────────────

  /**
   * MV3 durability guard: the SW can be killed between attach and detach,
   * orphaning the CDP session (infobar sticks, next attach fails with
   * "already attached"). On that failure we reclaim our own target and retry.
   */
  async function ensureAttached(tabId: number) {
    try {
      await browser.debugger.attach({ tabId }, "1.3")
    } catch (err) {
      if (!String((err as Error)?.message ?? "").includes("already attached")) throw err
      const targets = await browser.debugger.getTargets()
      const orphans = targets.filter((t) => t.attached && t.tabId === tabId)
      if (orphans.length > 0) await browser.debugger.detach({ tabId }).catch(() => {})
      await browser.debugger.attach({ tabId }, "1.3")
    }
    // Input events ride the render loop: an occluded/back window pauses the
    // compositor and later `Input.*` calls never resolve. Two mitigations (both
    // fire-and-forget: neither may block the attach path):
    //  · Page.bringToFront — un-occludes the tab's window (puppeteer standard).
    //  · Emulation.setFocusEmulationEnabled — renderer behaves as focused.
    void browser.debugger
      .sendCommand({ tabId }, "Page.bringToFront", {})
      .catch(() => {})
    void browser.debugger
      .sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true } as never)
      .catch(() => {})
  }

  function pngSize(b64: string) {
    // IHDR: width at byte 16, height at byte 20 (big-endian) — no Buffer in MV3.
    const bin = atob(b64)
    const u32 = (i: number) =>
      ((bin.charCodeAt(i) & 255) * 2 ** 24 +
        (bin.charCodeAt(i + 1) << 16) +
        (bin.charCodeAt(i + 2) << 8) +
        (bin.charCodeAt(i + 3) & 255))
    return { imgW: u32(16), imgH: u32(20) }
  }

  /** tabId → #ops in flight holding the debugger attached (refcount). */
  const cdpOpsInFlight = new Map<number, number>()
  /** tabId → promise serializing every CDP op for that tab. */
  const cdpLocks = new Map<number, Promise<unknown>>()

  /** Serialized, refcounted CDP session: attach once per tab, detach after the last in-flight op. */
  async function withDebuggerSession(
    tabId: number,
    fn: (send: CdpSender) => Promise<unknown>,
  ) {
    const run = async () => {
      await ensureAttached(tabId)
      cdpOpsInFlight.set(tabId, (cdpOpsInFlight.get(tabId) ?? 0) + 1)
      try {
        const send: CdpSender = async (command, params) => {
          const res = (await browser.debugger.sendCommand({ tabId }, command, params as never)) as CdpReply
          return res?.result ?? res
        }
        return await fn(send)
      } finally {
        const left = (cdpOpsInFlight.get(tabId) ?? 1) - 1
        if (left <= 0) {
          cdpOpsInFlight.delete(tabId)
          await browser.debugger.detach({ tabId }).catch(() => {})
        } else {
          cdpOpsInFlight.set(tabId, left)
        }
      }
    }
    const prev = cdpLocks.get(tabId) ?? Promise.resolve()
    const next = prev.then(run, run)
    cdpLocks.set(tabId, next)
    return await next
  }

  /** tabId → {imgW, imgH} of the last screenshot — coordinate space reference. */
  const screenshotContext = new Map<number, { imgW: number; imgH: number }>()

  const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  async function withDebugger(tabId: number, command: string, params: Record<string, unknown>): Promise<CdpReply> {
    return (await withDebuggerSession(tabId, async (send) => send(command, params))) as CdpReply
  }

  // ── Tool handlers ──────────────────────────────────────────────────────────

  const tools = {
    async get_page_text(args: Args, scope: Scope) {
      const entry = await ensureGroup(scope.sessionId, false)
      const tab = await requireMemberTab(args, entry, "get_page_text")
      const res = await withDebugger(tab.id, "Runtime.evaluate", {
        expression: 'document.body ? document.body.innerText : ""',
        returnByValue: true,
      })
      // send() already unwraps the CDP envelope → we hold the RemoteObject itself
      // ({type:"string", value:…}); pre-WXT code read res.result.value on the raw
      // response and double-unwraped to "" (regression caught by the MCP e2e).
      const raw = typeof res?.value === "string" ? res.value : ""
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

    async computer(args: Args, scope: Scope) {
      const entry = await ensureGroup(scope.sessionId, false)
      const tab = await requireMemberTab(args, entry, "computer")
      const action = String(args.action ?? "")

      return withDebuggerSession(tab.id, async (send) => {
        if (action === "screenshot") {
          const png = (await send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
          })) as { data: string }
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
        const metrics = (await send("Page.getLayoutMetrics")) as {
          cssVisualViewport?: { width?: number; height?: number }
          layoutViewport?: { width?: number; height?: number }
        }
        const css = metrics.cssVisualViewport ?? metrics.layoutViewport ?? {}
        const cssW = css.width || 1280
        const cssH = css.height || 800
        const scaleFor = (x: number, y: number) => {
          const sc = screenshotContext.get(tab.id)
          if (!sc || !sc.imgW || !sc.imgH || !cssW || !cssH) return { x, y }
          return { x: Math.round((x * cssW) / sc.imgW), y: Math.round((y * cssH) / sc.imgH) }
        }
        const mouse = (o: Record<string, unknown>) => send("Input.dispatchMouseEvent", o)
        const clamp = (p: { x: number; y: number }) => ({
          x: Math.max(0, Math.min(cssW, Math.round(p.x))),
          y: Math.max(0, Math.min(cssH, Math.round(p.y))),
        })

        switch (action) {
          case "left_click":
          case "right_click":
          case "double_click":
          case "triple_click":
          case "hover": {
            if (!args.coordinates) throw new Error(`computer: ${action} requires coordinates {x,y}`)
            const p = clamp(scaleFor(args.coordinates.x, args.coordinates.y))
            const clickCount: Record<string, number> = { left_click: 1, right_click: 1, double_click: 2, triple_click: 3, hover: 0 }
            await mouse({ type: "mouseMoved", x: p.x, y: p.y })
            if ((clickCount[action as string] ?? 0) > 0) {
              await mouse({
                type: "mousePressed",
                x: p.x,
                y: p.y,
                button: action === "right_click" ? "right" : "left",
                clickCount: clickCount[action as string] ?? 0,
                buttons: 1,
              })
              await mouse({
                type: "mouseReleased",
                x: p.x,
                y: p.y,
                button: action === "right_click" ? "right" : "left",
                clickCount: clickCount[action as string] ?? 0,
                buttons: 0,
              })
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
            const dir: Record<string, number[]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
            const dxy = dir[args.scrollDirection ?? "down"] ?? [0, 1]
            await mouse({ type: "mouseWheel", x: p.x, y: p.y, deltaX: dxy[0]! * amount * 240, deltaY: dxy[1]! * amount * 240 })
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
            if (keys.length === 0) throw new Error('computer: key requires a spec like "Enter" or "ctrl+a"')
            for (const k of keys) {
              const press = keyPressEvent(k)
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

    async tabs_context(args: Args, scope: Scope) {
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

    async tabs_create(args: Args, scope: Scope) {
      const entry = await ensureGroup(scope.sessionId, false)
      const url = args.url ?? "https://example.com"
      if (!isWebViewUrl(url)) throw new Error(urlSchemeError(url))
      const tab = (await browser.tabs.create({ url, active: args.active !== false, windowId: entry.windowId })) as unknown as TabLike
      await browser.tabs.group({ tabIds: [tab.id], groupId: entry.tabGroupId })
      void syncPanelTab(tab.id)
      return { tabId: tab.id, url, tabGroupId: entry.tabGroupId }
    },

    async tabs_close(args: Args, scope: Scope) {
      const entry = await ensureGroup(scope.sessionId, false)
      const tab = await requireMemberTab(args, entry, "tabs_close")
      await browser.tabs.remove(tab.id)
      await forgetGroupIfGone(scope.sessionId) // last tab closed ⇒ group goes away
      return { closed: tab.id }
    },

    async navigate(args: Args, scope: Scope) {
      const entry = await ensureGroup(scope.sessionId, false)
      const tab = await requireMemberTab(args, entry, "navigate")
      const url = String(args.url ?? "")
      if (!isWebViewUrl(url)) throw new Error(urlSchemeError(url))
      await browser.tabs.update(tab.id, { url })
      await waitForLoad(tab.id)
      const fresh = (await browser.tabs.get(tab.id)) as TabLike
      return { tabId: tab.id, url: fresh.url, title: fresh.title, status: "complete" }
    },
  }

  function waitForLoad(tabId: number, timeoutMs = NAV_WAIT_TIMEOUT_MS) {
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        browser.tabs.onUpdated.removeListener(listener)
        resolve("timeout") // navigation still useful; the model sees the timeout
      }, timeoutMs)
      function listener(updatedId: number, info: { status?: string }) {
        if (updatedId !== tabId || info.status !== "complete") return
        clearTimeout(timer)
        browser.tabs.onUpdated.removeListener(listener)
        resolve("complete")
      }
      browser.tabs.onUpdated.addListener(listener)
    })
  }

  // ── Dispatcher ─────────────────────────────────────────────────────────────

  async function dispatchTool(msg: HostMessage) {
    const scope: Scope = { sessionId: msg.sessionScope?.sessionId ?? "local", tabGroupId: msg.sessionScope?.tabGroupId }
    const tool = msg.tool
    const handler = (tools as unknown as Record<string, (a: Args, s: Scope) => Promise<unknown> | undefined>)[tool]
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
      const obj = (result ?? {}) as { content?: unknown[] }
      const content = Array.isArray(obj.content) ? obj.content : [{ type: "text", text: JSON.stringify(result) }]
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
        error: { message: String((err as Error)?.message ?? err) },
      })
    }
  }

  // ── Native messaging port ──────────────────────────────────────────────────

  function browserNotifications(o: Record<string, unknown>): void {
    ;(browser as unknown as { notifications?: { create(o: unknown): void } }).notifications?.create(o)
  }

  function connectHost() {
    if (port) return
    setStatus({ type: "connecting" } as never)
    try {
      port = browser.runtime.connectNative(HOST_NAME)
    } catch (err) {
      port = null
      setStatus({ type: "host_missing", detail: String(err) } as never)
      return
    }
    port.onMessage.addListener((msg: HostMessage) => handleHostMessage(msg))
    port.onDisconnect.addListener(() => {
      const detail = (browser.runtime as any).lastError?.message ?? "host exited"
      port = null
      setStatus({ type: "disconnected", detail } as never)
      scheduleReconnect()
    })
    port.postMessage({ type: "ping" } as never)
    port.postMessage({ type: "get_status" } as never)
  }

  function handleHostMessage(msg: HostMessage) {
    switch (msg?.type) {
      case "pong":
        setStatus({ type: "connected" } as never)
        break
      case "status_response":
        setStatus({
          type: "connected",
          hostVersion: msg.nativeHostVersion,
          mcpClients: msg.mcpClients,
          extensionConnected: msg.extensionConnected,
          scratchDir: typeof msg.defaultScratchDir === "string" ? msg.defaultScratchDir : "",
        } as never)
        break
      case "mcp_connected":
      case "mcp_disconnected":
        if (port) port.postMessage({ type: "get_status" } as never)
        break
      case "tool_request":
        dispatchTool(msg)
        break
      case "notification":
        // keepalive beats reset the SW idle timer; other events surface as a
        // real notification.
        if (msg.event === "keepalive") break
        browserNotifications({
          type: "basic",
          title: "OpenCode in Chrome",
          message: String(msg.event ?? ""),
        })
        break
      case "op_response": {
        const pending = typeof msg.id === "string" ? pendingOps.get(msg.id) : undefined
        if (pending) {
          pendingOps.delete(msg.id)
          if (msg.ok === true) pending.resolve(msg.result)
          else {
            const err = new Error(String(msg?.error?.message ?? "op failed")) as Error & { code?: string }
            err.code = msg?.error?.code
            pending.reject(err)
          }
        }
        break
      }
      case "op_event":
        browser.runtime
          .sendMessage({ kind: "opEvent", event: msg.event, properties: msg.properties })
          .catch(() => {}) // no receiver (no panel open) is normal
        break
      default:
        break
    }
  }

  // ── Keep-alive & reconnection ──────────────────────────────────────────────

  let reconnectAttempts = 0

  function scheduleReconnect() {
    const delay = Math.min(30_000, 500 * 2 ** reconnectAttempts++)
    setTimeout(() => connectHost(), delay)
  }

  browser.alarms.create("keepalive", { periodInMinutes: PING_PERIOD_MIN })
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "keepalive") return
    connectHost()
    if (port) port.postMessage({ type: "ping" } as never)
  })

  // ── Side panel messaging ───────────────────────────────────────────────────

  // Modo B (T17): the panel names operations; the host holds the credentials
  // (I4) and runs them against the local OpenCode server. Responses are
  // correlated by id; SSE events fan out to every extension page.
  const pendingOps = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error & { code?: string }) => void }>()
  let opSeq = 0

  function sendOp(op: string, args?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!port) {
        reject(new Error("bridge not connected — the native host must be running"))
        return
      }
      const id = `op-${++opSeq}-${Date.now().toString(36)}`
      const timer = setTimeout(() => {
        pendingOps.delete(id)
        reject(new Error(`op ${op} timed out`))
      }, 30_000)
      pendingOps.set(id, {
        resolve: (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      port?.postMessage({ type: "op_request", id, op, args } as never)
    })
  }

  browser.runtime.onMessage.addListener(
    (msg: HostMessage & { kind?: string; op?: string; args?: any }, sender, sendResponse) => {
      if (msg?.kind === "getStatus") {
        sendResponse(lastStatus)
      } else if (msg?.kind === "op" && typeof msg.op === "string") {
        // Local ops (no server, no host roundtrip): the panel's session context.
        if (msg.op === "panel_context") {
          const windowId = Number(msg.args?.windowId)
          const scope = Number.isFinite(windowId) ? panelScopeByWindow.get(windowId) : undefined
          sendResponse({ ok: true, result: scope ?? null })
          return false
        }
        if (msg.op === "ensure_group") {
          void (async () => {
            const requestedWindow = Number(msg.args?.windowId)
            const windowId = Number.isFinite(requestedWindow) ? requestedWindow : sender?.tab?.windowId
            let hostTabId = windowId !== undefined ? panelHostByWindow.get(windowId) : undefined
            if (windowId !== undefined && hostTabId === undefined) {
              const [active] = await browser.tabs.query({ windowId, active: true }).catch(() => [])
              hostTabId = active?.id
            }
            return ensureGroup(String(msg.args?.sessionId ?? ""), true, {
              windowId,
              adoptable: true, // panel flow: one OpenCode group per window, adopt + clear
              hostTabId,
            })
          })().then(
            (entry) => sendResponse({ ok: true, result: entry }),
            (err: Error) => sendResponse({ ok: false, error: err.message }),
          )
          return true
        }
        if (msg.op === "group_tabs") {
          void (async () => {
            const entry = sessionGroups.get(String(msg.args?.sessionId ?? ""))
            if (!entry) return { ok: true, result: [] }
            const tabs = await browser.tabs.query({ groupId: entry.tabGroupId })
            return { ok: true, result: tabs.map((t) => ({ id: t.id, title: t.title ?? "", active: t.active })) }
          })().then(
            (r) => sendResponse(r),
            (err: Error) => sendResponse({ ok: false, error: err.message }),
          )
          return true
        }
        if (msg.op === "current_page") {
          void (async () => {
            const entry = sessionGroups.get(String(msg.args?.sessionId ?? ""))
            if (!entry) return { ok: true, result: null }
            const tabs = await browser.tabs.query({ groupId: entry.tabGroupId })
            const page = tabs.find((t) => t.active) ?? tabs[0]
            if (!page?.id) return { ok: true, result: null }
            return { ok: true, result: { tabId: page.id, url: page.url ?? "", title: page.title ?? "" } }
          })().then(
            (r) => sendResponse(r),
            (err: Error) => sendResponse({ ok: false, error: err.message }),
          )
          return true
        }
        if (msg.op === "focus_tab") {
          const id = Number(msg.args?.tabId)
          if (!Number.isFinite(id)) {
            sendResponse({ ok: false, error: "focus_tab: tabId required" })
            return false
          }
          void (async () => {
            const tab = await browser.tabs.update(id, { active: true })
            if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true })
            return { ok: true, result: { tabId: id } }
          })().then(
            (r) => sendResponse(r),
            (err: Error) => sendResponse({ ok: false, error: err.message }),
          )
          return true
        }
        void sendOp(msg.op, msg.args).then(
          (result) => sendResponse({ ok: true, result }),
          (err: Error & { code?: string }) => sendResponse({ ok: false, error: err.message, code: err.code }),
        )
        return true // async sendResponse
      }
      return false
    },
  )

  // ── Side panel scoped to its OpenCode tab group (specs/08) ─────────────────
  // Removing side_panel.default_path (wxt hook) kills the global instance;
  // enable per tab and hide it outside the window's OpenCode group.
  browser.action.onClicked.addListener((tab) => {
    if (tab.id === undefined || tab.windowId === undefined) return
    panelHostByWindow.set(tab.windowId, tab.id)
    // Keep the click gesture: no await between setOptions and open.
    void browser.sidePanel.setOptions({ tabId: tab.id, path: PANEL_PATH, enabled: true }).catch(() => {})
    void browser.sidePanel.open({ tabId: tab.id }).catch(() => {})
  })
  browser.tabs.onActivated.addListener(({ tabId }) => {
    void syncPanelTab(tabId)
  })
  browser.tabs.onCreated.addListener((tab) => {
    if (tab.id !== undefined) void syncPanelTab(tab.id)
  })
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.groupId !== undefined) void syncPanelTab(tabId)
  })
  browser.tabs.onRemoved.addListener((tabId, info) => {
    if (panelHostByWindow.get(info.windowId) === tabId) panelHostByWindow.delete(info.windowId)
  })
  browser.windows.onRemoved.addListener((windowId) => {
    panelScopeByWindow.delete(windowId)
    panelHostByWindow.delete(windowId)
    windowGroups.delete(windowId)
    void savePanelScopes()
    void saveSessionGroups()
  })
  browser.tabGroups.onRemoved.addListener((group) => {
    for (const [windowId, scope] of panelScopeByWindow) {
      if (scope.groupId !== group.id) continue
      panelScopeByWindow.delete(windowId)
      panelHostByWindow.delete(windowId)
      void savePanelScopes()
      void syncPanelScope(windowId)
      browser.runtime.sendMessage({ kind: "panelScope", windowId, sessionId: null }).catch(() => {})
    }
  })
  // Chrome 141+: know which tab hosts the panel even if it was opened from the
  // side-panel menu (no action click).
  const sidePanelEvents = browser.sidePanel as unknown as {
    onOpened?: { addListener(cb: (info: { tabId?: number; windowId: number }) => void): void }
    onClosed?: { addListener(cb: (info: { tabId?: number; windowId: number }) => void): void }
  }
  sidePanelEvents.onOpened?.addListener((info) => {
    if (info.tabId !== undefined) panelHostByWindow.set(info.windowId, info.tabId)
    void syncPanelScope(info.windowId)
  })
  sidePanelEvents.onClosed?.addListener(() => {
    // Keep the scope: closing the panel must not end the chat or the group.
  })

  browser.runtime.onInstalled.addListener(() => {
    void initPanelScoping()
    connectHost()
  })
  browser.runtime.onStartup.addListener(() => connectHost())

  void (async () => {
    await loadSessionGroups()
    connectHost()
    await loadPanelScopes()
    await initPanelScoping()
  })()
})
