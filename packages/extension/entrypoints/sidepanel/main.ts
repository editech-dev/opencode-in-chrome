/** Side panel — bridge status + (M3) OpenCode chat. (js on purpose: Fase 3 rewrites this UI.) */
import { browser } from "wxt/browser"

const el = (id: string) => document.getElementById(id)

function render(status: { type?: string; hostVersion?: string | null; mcpClients?: number } | null) {
  const dot = (cls: string) => `<span class="dot ${cls}"></span>`
  const state = el("bridge-state")!
  switch (status?.type) {
    case "connected":
      state.innerHTML = `${dot("ok")} connected`
      break
    case "connecting":
      state.innerHTML = `${dot("warn")} connecting…`
      break
    case "host_missing":
      state.innerHTML = `${dot("bad")} host not installed`
      break
    default:
      state.innerHTML = `${dot("warn")} disconnected`
  }
  el("host-version")!.textContent = status?.hostVersion ?? "—"
  el("mcp-clients")!.textContent = String(status?.mcpClients ?? "—")
}

async function refresh() {
  const resp = await browser.runtime.sendMessage({ kind: "getStatus" } as never).catch(() => null)
  if (resp) render(resp as never)
}

browser.storage.local
  .get("bridgeStatus")
  .then((v) => (v as { bridgeStatus?: never }).bridgeStatus !== undefined && render((v as never) as never))
browser.runtime.onMessage.addListener((msg) => {
  if ((msg as never as { kind?: string })?.kind === "bridgeStatus") render((msg as never as { status: never }).status)
})
el("refresh")!.addEventListener("click", () => void refresh())

// While the panel is open, poll the SW every 5 s: each message resets the MV3
// idle timer, keeping the SW (and with it the native host) alive during use.
setInterval(() => void refresh(), 5_000)
void refresh()
