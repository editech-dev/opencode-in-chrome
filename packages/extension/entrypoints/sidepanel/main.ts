/**
 * Side panel — Modo B chat (T18–T22 + estética Claude/Gemini): tu OpenCode
 * local, chat-first, sin cromo. La sesión/los ajustes viven detrás de ⟲/⚙;
 * el modelo es un chip dentro del composer (PATCH en vivo sobre el chat
 * activo — contrato verificado); el strip de tabs muestra SOLO el grupo de
 * esta sesión (T-D1: el grupo nace en la ventana actual, paridad Claude).
 */

import { browser } from "wxt/browser"
import { movePermissionDecision, type PermissionDecision } from "../../../core/src/perm-nav"
import { isPanelSession } from "../../../core/src/panel-sessions"
import { isDefaultPanelTitle, panelTitleFromPrompt } from "../../../core/src/panel-title"

const el = (id: string) => document.getElementById(id)

// ── op transport (names only; the host holds credentials — I4) ───────────────

type OpReply = { ok: boolean; result?: unknown; error?: string; code?: string }

async function op(opName: string, args?: unknown): Promise<unknown> {
  const resp = (await browser.runtime.sendMessage({ kind: "op", op: opName, args } as never)) as OpReply | undefined
  if (!resp) throw new Error(`op ${opName}: no bridge response`)
  if (!resp.ok) {
    const err = new Error(resp.error ?? `op ${opName} failed`) as Error & { code?: string }
    err.code = resp.code
    throw err
  }
  return resp.result
}

type Envelope<T> = { location?: unknown; data?: T }

function unwrapEnvelope<T>(result: unknown): T[] {
  const env = result as Envelope<T> | T[] | undefined
  return Array.isArray(env) ? env : Array.isArray(env?.data) ? env.data : []
}

// ── state ────────────────────────────────────────────────────────────────────

type ModelRow = { providerID: string; modelID: string; name: string; enabled: boolean; status: string }
type AgentRow = { id: string; name: string; mode: string; hidden: boolean }
type SessionRow = { id: string; title?: string; location?: { directory?: string }; time?: { updated?: number } }
type MessageRow = {
  id: string
  sessionID: string
  role: string
  parts: Array<{ type: string; text?: string; name?: string }>
  error?: { type?: string; message?: string }
  model?: { id?: string; providerID?: string }
}
type Fav = { providerID: string; modelID: string; name: string }

const state = {
  sessions: [] as SessionRow[],
  activeId: null as string | null,
  messages: new Map<string, MessageRow>(),
  models: [] as ModelRow[],
  agents: [] as AgentRow[],
  settings: { providers: [] as string[], favorites: [] as Fav[] },
  selModel: "",
  selAgent: "",
  busy: false,
  /** Sessions created by this panel (specs/10) — persisted across restarts. */
  panelIds: new Set<string>(),
  sessionQ: "",
  /** Pending permission asks for the ACTIVE session (permission.asked). */
  pending: [] as Array<{ id: string; sessionID: string; action: string; metadata?: { input?: unknown } }>,
  /** Keyboard selection for the permission card: action + decision (specs/07 UX). */
  permSel: null as { id: string; decision: PermissionDecision } | null,
  /** Readiness of the local OpenCode server (specs/07) — independent from the bridge. */
  server: "unknown" as "unknown" | "up" | "down",
  serverDetail: "",
  serverCode: "",
  /** Native-host bridge status (connected / connecting / disconnected / host_missing). */
  bridgeType: "connecting",
  /** Command offered by the "Copiar comando" button for the current notice. */
  noticeCommand: "opencode service start",
}

let panelWindowId: number | null = null
let chatBooted = false
let replying = false
const titleInFlight = new Set<string>()

let scratchDir = await (async () => {
  const v = (await browser.storage.local.get("scratchDir").catch(() => ({}))) as { scratchDir?: string }
  return v.scratchDir ?? ""
})()
/** A user-configured directory wins over the bridge default. */
const scratchDirFromStorage = scratchDir !== ""

async function loadPersisted() {
  const got = (await browser.storage.local
    .get(["panelSettings", "panelSelect", "panelIds"])
    .catch(() => ({}))) as {
    panelSettings?: { providers?: string[]; favorites?: Fav[] }
    panelSelect?: { model?: string; agent?: string }
    panelIds?: string[]
  }
  state.settings.providers = got.panelSettings?.providers ?? []
  state.settings.favorites = got.panelSettings?.favorites ?? []
  state.selModel = got.panelSelect?.model ?? ""
  state.selAgent = got.panelSelect?.agent ?? ""
  state.panelIds = new Set(got.panelIds ?? [])
}

async function persistSelection() {
  await browser.storage.local.set({ panelSelect: { model: state.selModel, agent: state.selAgent } } as never)
}

async function savePanelIds() {
  // Cap the set so long-lived installs do not grow storage indefinitely.
  await browser.storage.local.set({ panelIds: [...state.panelIds].slice(-500) } as never).catch(() => {})
}

// ── helpers ──────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function modelKey(m: { providerID: string; modelID: string }): string {
  return `${m.providerID}/${m.modelID}`
}

function modelName(key: string): string {
  const m = state.models.find((x) => modelKey(x) === key)
  return m?.name ?? key
}

function activeModels(): ModelRow[] {
  return state.models.filter((m) => m.enabled && m.status === "active")
}

function listedProviders(): string[] {
  const live = new Set(activeModels().map((m) => m.providerID))
  const chosen = state.settings.providers.filter((p) => live.has(p))
  return chosen.length > 0 ? chosen : [...live]
}

// ── status → header dot (server readiness; specs/07) ─────────────────────────

const SERVER_DOWN_CODES = new Set(["server_not_running", "server_unreachable", "server_auth_failed"])

function isServerDown(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code !== undefined && SERVER_DOWN_CODES.has(code)
}

function serverCodeOf(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? ""
}

function renderHeader() {
  const dot = el("bridge-dot")!
  const txt = el("bridge-txt")!
  if (state.bridgeType === "host_missing") {
    dot.className = "dot bad"
    txt.textContent = "sin host"
  } else if (state.bridgeType === "disconnected") {
    dot.className = "dot bad"
    txt.textContent = "sin puente"
  } else if (state.bridgeType !== "connected") {
    dot.className = "dot warn"
    txt.textContent = "conectando…"
  } else if (state.server === "up") {
    dot.className = "dot ok"
    txt.textContent = "conectado"
  } else if (state.server === "down") {
    dot.className = "dot warn"
    txt.textContent = "apagado"
  } else {
    dot.className = "dot warn"
    txt.textContent = "conectando…"
  }
  dot.title = `bridge ${state.bridgeType} · OpenCode ${state.server}${state.serverDetail ? ` — ${state.serverDetail}` : ""}`
}

function renderStatus(status: { type?: string; hostVersion?: string | null; scratchDir?: string } | null) {
  const prev = state.bridgeType
  state.bridgeType = status?.type ?? "connecting"
  if (!scratchDirFromStorage && typeof status?.scratchDir === "string" && status.scratchDir) {
    scratchDir = status.scratchDir
  }
  renderHeader()
  if (prev !== state.bridgeType) renderView()
}

browser.runtime.onMessage.addListener((msg: { kind?: string; status?: unknown; event?: string; properties?: unknown; windowId?: number; sessionId?: string }) => {
  if (msg?.kind === "bridgeStatus") renderStatus(msg.status as never)
  if (msg?.kind === "opEvent" && typeof msg.event === "string") onOpEvent(msg.event, msg.properties)
  if (msg?.kind === "panelScope" && panelWindowId !== null && msg.windowId === panelWindowId) {
    if (msg.sessionId && msg.sessionId !== state.activeId) openChat(msg.sessionId)
  }
})

// ── markdown-lite ────────────────────────────────────────────────────────────

function renderText(text: string): string {
  const blocks = text.split(/```(?:\w*)\n?([\s\S]*?)```/g)
  let out = ""
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] ?? ""
    if (i % 2 === 1) out += `<pre><code>${esc(block.replace(/\n$/, ""))}</code></pre>`
    else out += esc(block).replace(/`([^`]+)`/g, "<code>$1</code>")
  }
  return out
}

// ── chat rendering ───────────────────────────────────────────────────────────

type StreamRow = { sessionID: string; role: "assistant"; texts: Map<number, string> }

const stream = new Map<string, StreamRow>()

function rowHtml(m: MessageRow): string {
  const who = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : "tool"
  const renderPart = (t: string): string => {
    if (who !== "user") return renderText(t)
    // The page-context prefix never shows raw — it becomes the 📄 chip.
    const hit = /^\[contexto: el usuario está viendo esta página — tabId \d+: (\S+?)\] ?([\s\S]*)$/.exec(t)
    if (!hit) return renderText(t)
    let host = hit[1] ?? ""
    try {
      host = new URL(host).host
    } catch {
      /* keep raw */
    }
    return `<div class="ctx">📄 ${esc(host)}</div>${renderText(hit[2] ?? "")}`
  }
  const text = m.parts
    .filter((p) => p.type === "text" && p.text !== undefined && p.text !== "")
    .map((p) => renderPart(p.text ?? ""))
    .join("<hr />")
  const steps = m.parts
    .filter((p) => p.type === "tool" && p.name)
    .map((p) => `⚙ ${esc(p.name ?? "")}`)
    .join(" · ")
  if (!text && !steps) {
    if (m.error?.message) {
      const tag = m.error.type ? `${m.error.type}: ` : ""
      const retry = state.selModel
        ? `<button class="btn-retry" data-retry="${esc(m.sessionID)}">🔁 reintentar con ${esc(modelName(state.selModel))}</button>`
        : `<span style="opacity:.8">elige un modelo con el chip 🤖</span>`
      return `<div class="msg error"><div class="who">error</div><div class="body">${esc(tag + m.error.message).slice(0, 340)}<div>${retry}</div></div></div>`
    }
    return ""
  }
  const inner = `${steps ? `<div class="steps">${steps}</div>` : ""}${text}${m.error ? `<div class="errline">⚠ ${esc((m.error.type ? `${m.error.type}: ` : "") + (m.error.message ?? ""))}</div>` : ""}`
  return `<div class="msg ${who}"><div class="who">${who === "user" ? "tú" : "assistant"}</div><div class="body">${inner}</div></div>`
}

function renderMessages() {
  const wrap = el("messages")!
  const historyRows = [...state.messages.values()].filter((m) => m.sessionID === state.activeId)
  const streamRows = [...stream.entries()]
    .filter(([id, s]) => s.sessionID === state.activeId && !state.messages.has(id))
    .map(([id, s]) => ({
      id,
      sessionID: s.sessionID,
      role: s.role,
      parts: [...s.texts.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => ({ type: "text", text: t })),
    } as MessageRow))
  const rows = [...historyRows, ...streamRows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 60
  wrap.innerHTML = rows.map(rowHtml).join("")
  if (nearBottom || state.busy) wrap.scrollTop = wrap.scrollHeight
}

/** Chat-first visibility: empty state ↔ messages, composer bar, tab strip. */
function renderView() {
  const hasChat = state.activeId !== null
  const bridgeDown = state.bridgeType === "disconnected" || state.bridgeType === "host_missing"
  const down = state.server === "down" || bridgeDown
  const up = state.server === "up" && !bridgeDown

  el("server-notice")!.style.display = down ? "flex" : "none"
  if (bridgeDown) {
    el("server-title")!.textContent = "Puente no conectado"
    el("server-body")!.innerHTML =
      "Abre Chrome con la extensión cargada. Si el problema sigue, reinstala el bridge con <code>oc-chrome-bridge install</code>."
    state.noticeCommand = "oc-chrome-bridge install"
  } else if (state.serverCode === "server_auth_failed") {
    el("server-title")!.textContent = "OpenCode rechazó la conexión"
    el("server-body")!.innerHTML =
      "Reinicia OpenCode para refrescar la credencial: <code>opencode service restart</code>."
    state.noticeCommand = "opencode service restart"
  } else {
    el("server-title")!.textContent = "OpenCode no está corriendo"
    el("server-body")!.innerHTML =
      "Abre una terminal y ejecuta <code>opencode service start</code> (o simplemente <code>opencode</code>). Esta ventana se conecta sola."
    state.noticeCommand = "opencode service start"
  }
  el("server-detail")!.textContent = bridgeDown ? "" : state.serverDetail
  el("empty")!.style.display = !down && !hasChat ? "" : "none"
  el("messages")!.style.display = up && hasChat ? "" : "none"
  el("composerbox")!.style.display = down || hasChat || !up ? "" : "none"
  el("chatmeta")!.style.display = up && hasChat ? "flex" : "none"
  const ta = el("composer") as HTMLTextAreaElement
  ta.disabled = !up
  ta.placeholder = bridgeDown
    ? "Puente no conectado"
    : down
      ? "OpenCode apagado — inícialo en tu terminal"
      : hasChat
        ? "¿Cómo te puedo ayudar? (Enter envía)"
        : "¿Cómo te puedo ayudar?"
  const s = state.sessions.find((x) => x.id === state.activeId)
  void s
  void refreshTabStrip()
}

function setServerState(next: "unknown" | "up" | "down", detail = "", code = "") {
  if (state.server === next && state.serverDetail === detail && state.serverCode === code) return
  const prev = state.server
  state.server = next
  state.serverDetail = detail
  state.serverCode = code
  renderHeader()
  renderView()
  if (next === "up" && prev !== "up") {
    if (state.activeId) {
      void loadHistory(state.activeId)
      void refreshTabStrip()
    } else {
      void ensureBootChat()
    }
  }
}

function markServerDown(err: unknown): void {
  const detail = String((err as Error)?.message ?? err).slice(0, 240)
  setServerState("down", detail, serverCodeOf(err))
}

async function ensureBootChat(): Promise<void> {
  if (chatBooted || state.server !== "up") return
  chatBooted = true
  try {
    const ctx = panelWindowId !== null
      ? ((await op("panel_context", { windowId: panelWindowId })) as { sessionId?: string } | null)
      : null
    if (ctx?.sessionId) openChat(ctx.sessionId)
    else void newChat()
  } catch {
    chatBooted = false
  }
}

function fmtTime(s: SessionRow): string {
  const ts = s.time?.updated
  if (!ts) return ""
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

// ── sessions dropdown ────────────────────────────────────────────────────────

function visibleSessions(): SessionRow[] {
  const q = state.sessionQ.trim().toLowerCase()
  const list = q ? state.sessions.filter((s) => (s.title ?? "").toLowerCase().includes(q)) : state.sessions
  return list.slice(0, 30)
}

function renderSessions() {
  const rows = visibleSessions()
  if (rows.length === 0) {
    el("session-list")!.innerHTML = `<div style="color: var(--muted); font-size: 11px; padding: 8px;">No hay chats del panel todavía — ＋ nueva.</div>`
    return
  }
  el("session-list")!.innerHTML = rows
    .map(
      (s) => `<div class="srow" data-id="${esc(s.id)}">
        <span class="t">${esc(s.title ?? "untitled")}</span>
        <span class="m">${esc(fmtTime(s))}</span>
      </div>`,
    )
    .join("")
}

function toggleOverlay(which: "sessions" | "settings" | "picker", open?: boolean) {
  const ids = { sessions: "sessions", settings: "settings", picker: "picker" } as const
  for (const key of Object.keys(ids) as Array<keyof typeof ids>) {
    const want = key === which ? (open ?? !el(ids[key])!.classList.contains("open")) : false
    el(ids[key])!.classList.toggle("open", want)
    if (key === "picker" && want) {
      ;(el("picker-q") as HTMLInputElement).value = ""
      renderPicker()
      ;(el("picker-q") as HTMLInputElement).focus()
    }
    if (key === "settings" && want) renderSettings()
    if (key === "sessions" && want) void refresh()
  }
}

function openChat(id: string | null) {
  state.activeId = id
  state.messages.clear()
  stream.clear()
  state.pending = []
  state.permSel = null
  const s = state.sessions.find((x) => x.id === id)
  el("composer")!.setAttribute("data-session", id ?? "")
  // El grupo nace EN ESTA VENTANA en cuanto abres el chat (paridad Claude).
  if (id) {
    void op("ensure_group", { sessionId: id, windowId: panelWindowId ?? undefined }).then(() => void refreshTabStrip(), () => {})
  }
  toggleOverlay("sessions", false)
  renderView()
  void loadHistory(id)
  renderMessages()
  renderPerms()
}

function closeChat() {
  openChat(null)
}

/** Tab chips of THIS session's group — visible proof of "solo lo de este grupo". */
async function refreshTabStrip() {
  const wrap = el("tabstrip")!
  if (!state.activeId) {
    wrap.style.display = "none"
    wrap.innerHTML = ""
    return
  }
  try {
    const tabs = (await op("group_tabs", { sessionId: state.activeId })) as Array<{ id: number; title: string; active: boolean }>
    wrap.style.display = tabs.length > 0 ? "flex" : "none"
    wrap.innerHTML = tabs
      .map((t) => `<span class="tabchip" data-tab="${t.id}" title="abrir pestaña">${t.active ? "● " : ""}${esc(t.title || "nueva pestaña")}</span>`)
      .join("")
  } catch {
    wrap.style.display = "none"
  }
}

async function loadHistory(id: string | null) {
  if (!id) return
  try {
    const rows = unwrapEnvelope<MessageRow>(await op("session_messages", { sessionId: id }))
    for (const m of rows) {
      const server = m as unknown as {
        id?: string
        sessionID?: string
        type?: string
        content?: MessageRow["parts"]
        error?: { type?: string; message?: string }
        model?: { id?: string; providerID?: string }
        agent?: string
      }
      if (!server.id) continue
      const row: MessageRow = {
        id: server.id,
        sessionID: server.sessionID ?? id,
        role: server.type ?? "assistant",
        parts: server.content ?? [],
        error: server.error,
        model: server.model,
      }
      if (server.agent) (row as unknown as { agent?: string }).agent = server.agent
      state.messages.set(server.id, row)
    }
    renderModelChip()
    renderMessages()
  } catch (err) {
    if (isServerDown(err)) markServerDown(err)
    else showError(`no se pudo cargar el historial: ${String((err as Error).message).slice(0, 120)}`)
  }
}

// ── SSE events → view (V2 shapes captured live from the real server) ─────────

function onOpEvent(event: string, properties: unknown): void {
  const p = (properties ?? {}) as Record<string, unknown>
  switch (event) {
    case "server.connected":
      el("err")!.textContent = ""
      break
    case "session.inbox.enqueued": {
      const sid = String(p.sessionID ?? "")
      const item = (p.item ?? {}) as { payload?: { text?: string } }
      const text = String(item.payload?.text ?? "")
      const id = `user:${String(p.inboxID ?? Date.now())}`
      if (sid && text) {
        state.messages.set(id, { id, sessionID: sid, role: "user", parts: [{ type: "text", text }] })
        if (sid === state.activeId) renderMessages()
      }
      break
    }
    case "session.step.started": {
      const sid = String(p.sessionID ?? "")
      const aid = String(p.assistantMessageID ?? "")
      if (sid === state.activeId && aid) {
        stream.set(aid, { sessionID: sid, role: "assistant", texts: new Map() })
        renderBusy(true)
        renderMessages()
      }
      break
    }
    case "session.reasoning.delta":
      break
    case "session.text.delta": {
      const row = stream.get(String(p.assistantMessageID ?? ""))
      if (!row) break
      const ord = Number(p.ordinal ?? 0)
      row.texts.set(ord, (row.texts.get(ord) ?? "") + String(p.delta ?? ""))
      if (row.sessionID === state.activeId) renderMessages()
      break
    }
    case "session.text.ended": {
      const row = stream.get(String(p.assistantMessageID ?? ""))
      if (!row) break
      row.texts.set(Number(p.ordinal ?? 0), String(p.text ?? ""))
      if (row.sessionID === state.activeId) renderMessages()
      break
    }
    case "session.step.ended":
    case "session.step.failed": {
      renderBusy(false)
      if (String(p.sessionID ?? "") === state.activeId) void loadHistory(state.activeId)
      break
    }
    case "session.execution.interrupted":
      renderBusy(false)
      break
    case "permission.asked": {
      const id = String(p.id ?? "")
      const sid = String(p.sessionID ?? "")
      if (!id || !sid) break
      if (sid === state.activeId) {
        state.pending.push({
          id,
          sessionID: sid,
          action: String(p.action ?? ""),
          metadata: (p.metadata as { input?: unknown }) ?? undefined,
        })
        renderPerms()
      }
      break
    }
    case "permission.replied": {
      const id = String(p.id ?? "")
      state.pending = state.pending.filter((x) => x.id !== id)
      if (state.permSel?.id === id) state.permSel = null
      renderPerms()
      break
    }
    case "session.renamed": {
      const sid = String(p.sessionID ?? "")
      const title = String(p.title ?? "")
      if (sid && title) {
        const s = state.sessions.find((x) => x.id === sid)
        if (s) s.title = title
      }
      break
    }
    case "session.usage.updated":
    case "session.execution.started":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.inbox.delivered":
    case "session.instructions.updated":
    case "session.created":
    case "project.updated":
      break
    default:
      break
  }
}

// ── permissions (T21) & busy (T20) ───────────────────────────────────────────

function renderPerms() {
  const wrap = el("permwrap")!
  const mine = state.pending.filter((x) => x.sessionID === state.activeId)
  const hadCards = wrap.childElementCount > 0
  const active = document.activeElement as HTMLElement | null
  const activeInPerms = active !== null && wrap.contains(active)

  if (mine.length === 0) {
    state.permSel = null
    wrap.innerHTML = ""
    if (hadCards && document.activeElement === document.body) (el("composer") as HTMLTextAreaElement).focus()
    return
  }
  if (!state.permSel || !mine.some((x) => x.id === state.permSel!.id)) {
    state.permSel = { id: mine[0]!.id, decision: "once" }
  }
  const sel = state.permSel
  const decisions = [
    ["once", "btn-yes", "✔ una vez"],
    ["always", "btn-always", "★ siempre"],
    ["reject", "btn-no", "✕ rechazar"],
  ] as const

  wrap.innerHTML = mine
    .map((x) => {
      const input = x.metadata?.input ? JSON.stringify(x.metadata.input) : ""
      const buttons = decisions
        .map(([decision, cls, label]) => {
          const chosen = sel.id === x.id && sel.decision === decision
          return `<button class="${cls}${chosen ? " selected" : ""}" data-reply="${decision}:${esc(x.id)}" data-decision="${decision}" data-req="${esc(x.id)}">${label}</button>`
        })
        .join("")
      return `<div class="perm-card" data-req="${esc(x.id)}">
        <div style="font-size:10px; color: var(--warn);">permission · el agente pide permiso</div>
        <div style="font-size:12px; margin: 2px 0;"><code>${esc(x.action)}</code>${input ? ` <span class="raw">${esc(input).slice(0, 120)}</span>` : ""}</div>
        <div style="display:flex; gap:4px; margin-top:4px;">${buttons}</div>
        <div class="perm-hint">←/→ elegir · Enter confirmar</div>
      </div>`
    })
    .join("")

  // Focus the default ("una vez") when the card first appears, or restore the
  // selection after a re-render. Never steal focus from the composer mid-typing
  // or from an open overlay (the user must see the ask before accepting it).
  const overlayOpen = document.querySelector(".overlay.open") !== null
  const shouldFocus = !overlayOpen && (!hadCards || active === document.body || activeInPerms)
  if (shouldFocus) {
    const target = wrap.querySelector<HTMLButtonElement>("button.selected") ?? wrap.querySelector("button")
    target?.focus({ preventScroll: true })
  }
}

async function replyPermission(decisionAndId: string): Promise<void> {
  const [decision, id] = decisionAndId.split(":")
  const ask = state.pending.find((x) => x.id === id)
  if (!ask || replying) return
  replying = true
  try {
    await op("permission_reply", { sessionId: ask.sessionID, requestId: id, decision })
    state.pending = state.pending.filter((x) => x.id !== id)
    if (state.permSel?.id === id) state.permSel = null
    renderPerms()
    if (document.activeElement === document.body) (el("composer") as HTMLTextAreaElement).focus()
  } catch (err) {
    showError(String((err as Error).message).slice(0, 160))
  } finally {
    replying = false
  }
}

async function interruptRun() {
  if (!state.activeId) return
  try {
    await op("interrupt", { sessionId: state.activeId })
  } catch (err) {
    showError(String((err as Error).message).slice(0, 160))
  }
}

function renderBusy(busy: boolean): void {
  state.busy = busy
  ;(el("stop-btn") as HTMLButtonElement).style.display = busy ? "" : "none"
}

function showError(m: string) {
  el("err")!.textContent = m
  setTimeout(() => {
    el("err")!.textContent = ""
  }, 6000)
}

// ── actions ──────────────────────────────────────────────────────────────────

async function maybeTitleSession(sessionId: string, raw: string): Promise<void> {
  const row = state.sessions.find((x) => x.id === sessionId)
  if (!row || !isDefaultPanelTitle(row.title ?? "")) return
  if (titleInFlight.has(sessionId)) return
  const next = panelTitleFromPrompt(raw)
  if (next === "Panel") return
  titleInFlight.add(sessionId)
  try {
    await op("patch_session", { sessionId, title: next })
    row.title = next
    renderSessions()
  } catch {
    // cosmetic only — retry on the next prompt if the server rejected it
  } finally {
    titleInFlight.delete(sessionId)
  }
}

async function sendPrompt() {
  const ta = el("composer") as HTMLTextAreaElement
  const raw = ta.value.trim()
  const sessionId = state.activeId
  if (!raw || !sessionId || state.busy) return
  if (state.server !== "up") {
    if (state.server === "unknown") setServerState("down")
    return
  }
  renderBusy(true)
  ;(el("send") as HTMLButtonElement).disabled = true
  ta.value = ""
  try {
    // Claude-parity: the agent always knows the page the user is looking at.
    // The chip "● Example Domain" over the composer is exactly this context.
    type PageCtx = { tabId: number; url: string; title: string }
    let page: PageCtx | null = null
    try {
      page = (await op("current_page", { sessionId })) as PageCtx | null
    } catch {}
    const text =
      page && /^https?:/.test(page.url)
        ? `[contexto: el usuario está viendo esta página — tabId ${page.tabId}: ${page.url}] ${raw}`
        : raw
    await op("prompt", { sessionId, text })
    void maybeTitleSession(sessionId, raw)
  } catch (err) {
    if (isServerDown(err)) markServerDown(err)
    else showError(String((err as Error).message))
    ta.value = raw
  } finally {
    renderBusy(false)
    ;(el("send") as HTMLButtonElement).disabled = false
  }
}

async function newChat() {
  if (state.server !== "up") {
    if (state.server === "unknown") setServerState("down")
    return
  }
  if (!scratchDir) {
    showError("bridge desconectado: no se pudo resolver el directorio del panel")
    return
  }
  try {
    const effective = state.selModel || (state.settings.favorites[0] ? modelKey(state.settings.favorites[0]) : "")
    const args: {
      title: string
      location: { directory: string }
      agent?: string
      model?: { providerID: string; id: string }
      permissions?: unknown[]
    } = {
      title: `Panel ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      location: { directory: scratchDir },
      permissions: [{ action: "oc-chrome_*", resource: "*", effect: "ask" }],
    }
    if (state.selAgent) args.agent = state.selAgent
    if (effective) {
      const [providerID = "", id = ""] = effective.split("/")
      args.model = { providerID, id }
    }
    const result = (await op("create_session", args)) as { data?: { id?: string; title?: string } }
    const created = result?.data
    if (!created?.id) throw new Error("el server rechazó la creación de la sesión")
    state.sessions.unshift({ id: created.id, title: created.title })
    state.panelIds.add(created.id)
    void savePanelIds()
    openChat(created.id)
    ;(el("composer") as HTMLTextAreaElement).focus()
  } catch (err) {
    if (isServerDown(err)) {
      chatBooted = false
      markServerDown(err)
    } else {
      chatBooted = true
      showError(String((err as Error).message))
    }
  }
}

/** Switch the model of the OPEN chat (live PATCH) or preselect for the next. */
async function applyModelChoice(key: string): Promise<void> {
  if (!key || !state.activeId) return
  const [providerID = "", id = ""] = key.split("/")
  try {
    await op("patch_session", { sessionId: state.activeId, model: { providerID, id } })
    void loadHistory(state.activeId)
  } catch (err) {
    showError(`el server rechazó el cambio de modelo: ${String((err as Error).message).slice(0, 120)}`)
  }
}

function lastUserText(sessionId: string): string {
  let text = ""
  for (const row of state.messages.values()) {
    if (row.sessionID === sessionId && row.role === "user") {
      text = row.parts.find((p) => p.type === "text")?.text ?? text
    }
  }
  return text
}

// ── model chip + picker ──────────────────────────────────────────────────────

function renderModelChip() {
  const b = el("model-chip") as HTMLButtonElement
  b.textContent = state.selModel ? `🤖 ${modelName(state.selModel)}` : "🤖 default"
  b.title = state.activeId
    ? `modelo del chat activo — cambiar aplica PATCH en vivo\n(último texto del chat: ${lastUserText(state.activeId).slice(0, 60)})`
    : "modelo para el próximo chat"
}

function renderPicker() {
  const q = (el("picker-q") as HTMLInputElement).value.trim().toLowerCase()
  const favs: ModelRow[] = state.settings.favorites
    .map((f) => state.models.find((m) => modelKey(m) === modelKey(f)))
    .filter((m): m is ModelRow => Boolean(m))
    .filter((m) => m.enabled && m.status === "active")
  const providers = new Set(listedProviders())
  const pool = activeModels()
    .filter((m) => providers.has(m.providerID))
    .filter((m) => !q || `${m.name} ${modelKey(m)}`.toLowerCase().includes(q))
    .sort((a, b) => a.providerID.localeCompare(b.providerID) || a.name.localeCompare(b.name))
  const rest = pool.filter((m) => !favs.some((f) => modelKey(f) === modelKey(m)))

  const row = (m: ModelRow, mark: string) =>
    `<div class="p-row" data-model="${esc(modelKey(m))}">
      <span class="n">${esc(m.name)} ${mark ? `<b style="color: var(--accent); font-size:10px">${mark}</b>` : ""}</span>
      <span class="raw">${esc(modelKey(m))}</span>
    </div>`

  const favBlock = favs.length > 0 ? `<div class="p-sec">★ FAVORITOS</div>` + favs.map((m) => row(m, "")).join("") : ""
  const groups = new Map<string, ModelRow[]>()
  for (const m of rest.slice(0, q ? 60 : 120)) {
    const arr = groups.get(m.providerID) ?? []
    arr.push(m)
    groups.set(m.providerID, arr)
  }
  const groupBlock = [...groups.entries()]
    .map(([p, ms]) => `<div class="p-sec">${esc(p.toUpperCase())} (${ms.length}${q ? "" : " primeros"})</div>` + ms.map((m) => row(m, "")).join(""))
    .join("")

  el("picker-list")!.innerHTML =
    `<div class="p-row" data-model=""><span class="n">— default del agente —</span></div>` + favBlock + groupBlock
}

// ── settings ─────────────────────────────────────────────────────────────────

function renderSettings() {
  const live = activeModels()
  const byProvider = new Map<string, ModelRow[]>()
  for (const m of live) {
    const arr = byProvider.get(m.providerID) ?? []
    arr.push(m)
    byProvider.set(m.providerID, arr)
  }
  const chosen = new Set(state.settings.providers)
  el("prov-list")!.innerHTML =
    [...byProvider.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(
        ([p, ms]) =>
          `<div class="prov-row"><input type="checkbox" data-prov="${esc(p)}" ${chosen.has(p) ? "checked" : ""}/>
           <label data-prov="${esc(p)}">${esc(p)}</label><span class="count">${ms.length} activos</span></div>`,
      )
      .join("") || `<div style="color: var(--muted); font-size: 11px;">sin server — arranca opencode</div>`

  el("fav-chips")!.innerHTML =
    state.settings.favorites
      .map(
        (f, i) =>
          `<span class="fav-chip"><button class="chip" data-unfav="${i}" title="${esc(modelKey(f))}" style="border-color: var(--accent); color: var(--accent);">★ ${esc(f.name)} ✕</button></span>`,
      )
      .join("") || `<span style="color: var(--muted); font-size: 11px;">sin favoritos — busca y añade ▼</span>`
}

function renderFavAdd() {
  const q = (el("fav-q") as HTMLInputElement).value.trim().toLowerCase()
  if (!q) {
    el("fav-add-list")!.innerHTML = ""
    return
  }
  const providers = new Set(listedProviders())
  const hits = activeModels()
    .filter((m) => providers.has(m.providerID))
    .filter((m) => `${m.name} ${modelKey(m)}`.toLowerCase().includes(q))
    .slice(0, 40)
  el("fav-add-list")!.innerHTML = hits
    .map((m) => {
      const isFav = state.settings.favorites.some((f) => modelKey(f) === modelKey(m))
      return `<div class="mrow"><span class="n">${esc(m.name)}</span><span class="raw">${esc(modelKey(m))}</span>
        <button data-fav="${esc(modelKey(m))}" ${isFav ? "disabled" : ""}>${isFav ? "★" : "☆ añadir"}</button></div>`
    })
    .join("")
}

// ── data loading ─────────────────────────────────────────────────────────────

async function fillSelectors() {
  try {
    const [models, agents] = await Promise.all([
      unwrapEnvelope<ModelRow>(await op("list_models")),
      unwrapEnvelope<AgentRow>(await op("list_agents")),
    ])
    state.models = models
    state.agents = agents.filter((a) => a.mode === "primary" && !a.hidden)
    const agentSel = el("agent-sel") as HTMLSelectElement
    agentSel.innerHTML =
      `<option value="">agent: default</option>` +
      state.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")
    if (state.selAgent && state.agents.some((a) => a.id === state.selAgent)) agentSel.value = state.selAgent
    renderModelChip()
    if (el("settings")!.classList.contains("open")) renderSettings()
  } catch {
    // Server not up yet — refresh retries.
  }
}

let syncTick = 0
let refreshing = false

async function refresh(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    await refreshOnce()
  } finally {
    refreshing = false
  }
}

async function refreshOnce() {
  const resp = (await browser.runtime.sendMessage({ kind: "getStatus" } as never).catch(() => null)) as never
  if (resp) renderStatus(resp as never)

  // Server readiness first: a chat is only created when the local service answers.
  try {
    await op("info")
    if (state.server !== "up") setServerState("up")
  } catch (err) {
    if (state.bridgeType !== "connected") return
    if (isServerDown(err)) markServerDown(err)
    else showError(String((err as Error).message).slice(0, 160))
    return
  }
  if (state.server === "up" && !state.activeId) void ensureBootChat()

  syncTick = (syncTick + 1) % 5
  try {
    if (state.models.length === 0) void fillSelectors()
    if (state.sessions.length === 0 || syncTick === 0) {
      const byDir = (await op("list_sessions", { directory: scratchDir })) as { data?: SessionRow[] }
      let rows = byDir?.data ?? []
      if (rows.length === 0) {
        // Some servers normalize/store the panel's location differently (e.g. a
        // macOS home path). Fall back to the panel's own markers so the history
        // still loads; CLI sessions never match them.
        const all = (await op("list_sessions")) as { data?: SessionRow[] }
        rows = (all?.data ?? []).filter((s) => isPanelSession(s, state.panelIds, scratchDir))
      }
      let added = false
      for (const s of rows) {
        if (!state.panelIds.has(s.id)) {
          state.panelIds.add(s.id)
          added = true
        }
      }
      if (added) void savePanelIds()
      state.sessions = rows
        .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
        .slice(0, 30)
      renderSessions()
    }
  } catch (err) {
    if (isServerDown(err)) markServerDown(err)
    else showError(String((err as Error).message).slice(0, 160))
    return
  }
  if (state.activeId && (syncTick === 1 || syncTick === 3)) void refreshTabStrip()
}

// ── boot & wiring ────────────────────────────────────────────────────────────

void (async () => {
  const saved = (await browser.storage.local.get("bridgeStatus").catch(() => ({}))) as { bridgeStatus?: unknown }
  renderStatus((saved.bridgeStatus ?? null) as never)
  panelWindowId = (await browser.windows.getCurrent().catch(() => null))?.id ?? null
  await loadPersisted()
  renderView()
  void refresh()
  // Chat creation is deferred until the server answers (specs/07): refresh()
  // calls ensureBootChat() on the down→up transition.
  setInterval(() => void refresh(), 5_000)

  // header
  el("new-chat2")!.addEventListener("click", () => void newChat())
  el("recent-btn")!.addEventListener("click", () => toggleOverlay("sessions"))
  el("settings-btn")!.addEventListener("click", () => toggleOverlay("settings"))
  el("settings-close")!.addEventListener("click", () => toggleOverlay("settings", false))

  // server-down notice (neutral, not an error)
  el("server-retry")!.addEventListener("click", () => void refresh())
  el("server-copy")!.addEventListener("click", () => {
    void navigator.clipboard.writeText(state.noticeCommand).catch(() => {})
  })

  // sessions dropdown
  el("new-chat")!.addEventListener("click", () => void newChat())
  ;(el("session-q") as HTMLInputElement).addEventListener("input", (ev) => {
    state.sessionQ = (ev.target as HTMLInputElement).value
    renderSessions()
  })
  el("session-list")!.addEventListener("click", (ev) => {
    const target = (ev.target as HTMLElement).closest(".srow") as HTMLElement | null
    if (target?.dataset.id) openChat(target.dataset.id)
  })

  // composer
  el("send")!.addEventListener("click", () => void sendPrompt())
  const ta = el("composer") as HTMLTextAreaElement
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault()
      void sendPrompt()
    }
  })
  ;(el("agent-sel") as HTMLSelectElement).addEventListener("change", (ev) => {
    state.selAgent = (ev.target as HTMLSelectElement).value
    void persistSelection()
  })
  el("stop-btn")!.addEventListener("click", () => void interruptRun())

  // permissions
  el("permwrap")!.addEventListener("click", (ev) => {
    const t = (ev.target as HTMLElement).closest("[data-reply]") as HTMLElement | null
    if (t?.dataset.reply) void replyPermission(t.dataset.reply)
  })
  // Keyboard: ←/→ picks the decision, Enter confirms (default = una vez).
  el("permwrap")!.addEventListener("keydown", (ev) => {
    if (!state.permSel) return
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return
    const req = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".perm-card")?.dataset.req
    if (req && state.permSel.id !== req) state.permSel = { id: req, decision: "once" }
    ev.preventDefault()
    ev.stopPropagation()
    const next = movePermissionDecision(state.permSel.decision, ev.key)
    state.permSel = { ...state.permSel, decision: next }
    renderPerms()
  })
  // Tab/click on a button makes it the selected decision (so Enter from the
  // composer confirms what the user is actually looking at).
  el("permwrap")!.addEventListener("focusin", (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-decision]")
    if (!btn || !state.permSel) return
    const req = btn.closest<HTMLElement>(".perm-card")?.dataset.req
    const decision = btn.dataset.decision as PermissionDecision | undefined
    if (!req || !decision) return
    if (state.permSel.id === req && state.permSel.decision === decision) return
    state.permSel = { id: req, decision }
    for (const b of el("permwrap")!.querySelectorAll<HTMLButtonElement>("button")) {
      b.classList.toggle("selected", b === btn)
    }
  })
  // Enter while the composer/body has focus accepts the selected permission.
  // Capture phase: it must win over the composer's Enter-to-send handler.
  document.addEventListener(
    "keydown",
    (ev) => {
      if (!state.permSel) return
      if (ev.key !== "Enter" || ev.shiftKey || ev.metaKey || ev.ctrlKey || ev.altKey) return
      const target = ev.target as HTMLElement | null
      if (target?.closest("#permwrap")) return // native button activation
      if (target?.id !== "composer" && target !== document.body) return
      ev.preventDefault()
      ev.stopPropagation()
      void replyPermission(`${state.permSel.decision}:${state.permSel.id}`)
    },
    true,
  )
  el("messages")!.addEventListener("click", (ev) => {
    const t = (ev.target as HTMLElement).closest("[data-retry]") as HTMLElement | null
    if (t?.dataset.retry) {
      const sid = t.dataset.retry
      const text = lastUserText(sid)
      void (async () => {
        await applyModelChoice(state.selModel)
        if (!text) return
        try {
          await op("prompt", { sessionId: sid, text })
        } catch (err) {
          showError(String((err as Error).message).slice(0, 160))
        }
      })()
    }
  })

  // tab strip chips → focus the tab
  el("tabstrip")!.addEventListener("click", (ev) => {
    const t = (ev.target as HTMLElement).closest("[data-tab]") as HTMLElement | null
    if (t?.dataset.tab) void op("focus_tab", { tabId: Number(t.dataset.tab) }).catch(() => {})
  })

  // settings interactions
  el("prov-list")!.addEventListener("change", (ev) => {
    const t = ev.target as HTMLInputElement
    if (t.dataset.prov === undefined) return
    const set = new Set(state.settings.providers)
    if (t.checked) set.add(t.dataset.prov)
    else set.delete(t.dataset.prov)
    state.settings.providers = [...set]
    void browser.storage.local.set({ panelSettings: state.settings } as never).then(() => renderFavAdd())
  })
  el("fav-chips")!.addEventListener("click", (ev) => {
    const t = (ev.target as HTMLElement).closest("[data-unfav]") as HTMLElement | null
    if (!t) return
    state.settings.favorites.splice(Number(t.dataset.unfav), 1)
    void browser.storage.local.set({ panelSettings: state.settings } as never).then(() => {
      renderSettings()
      renderModelChip()
    })
  })
  ;(el("fav-q") as HTMLInputElement).addEventListener("input", () => renderFavAdd())
  el("fav-add-list")!.addEventListener("click", (ev) => {
    const t = (ev.target as HTMLElement).closest("[data-fav]") as HTMLElement | null
    const key = t?.dataset.fav
    if (!key) return
    const m = state.models.find((x) => modelKey(x) === key)
    if (!m) return
    if (state.settings.favorites.some((f) => modelKey(f) === key)) return
    if (state.settings.favorites.length >= 4) {
      showError("máximo 4 favoritos — quita uno primero")
      return
    }
    state.settings.favorites.push({ providerID: m.providerID, modelID: m.modelID, name: m.name })
    void browser.storage.local.set({ panelSettings: state.settings } as never).then(() => {
      renderSettings()
      renderFavAdd()
      renderModelChip()
    })
  })

  // picker interactions
  el("model-chip")!.addEventListener("click", () => toggleOverlay("picker"))
  ;(el("picker-q") as HTMLInputElement).addEventListener("input", () => renderPicker())
  el("picker-list")!.addEventListener("click", (ev) => {
    const t = (ev.target as HTMLElement).closest("[data-model]") as HTMLElement | null
    if (!t) return
    state.selModel = t.dataset.model ?? ""
    void persistSelection().then(() => {
      renderModelChip()
      toggleOverlay("picker", false)
      void applyModelChoice(state.selModel)
    })
  })

  // SSE pipe on while the panel exists (host skips broadcasts when no page)
  try {
    await op("events_on")
  } catch {
    /* bridge not connected yet */
  }
})()
