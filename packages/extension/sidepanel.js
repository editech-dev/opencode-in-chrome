/** Side panel — bridge status + (M3) OpenCode chat. */

const el = (id) => document.getElementById(id)

function render(status) {
  const dot = (cls) => `<span class="dot ${cls}"></span>`
  const state = el("bridge-state")
  switch (status?.type) {
    case "connected":
      state.innerHTML = `${dot("ok")} connected`
      break
    case "host_missing":
      state.innerHTML = `${dot("bad")} host not installed`
      break
    default:
      state.innerHTML = `${dot("warn")} disconnected`
  }
  el("host-version").textContent = status?.hostVersion ?? "—"
  el("mcp-clients").textContent = status?.mcpClients ?? "—"
}

async function refresh() {
  const resp = await chrome.runtime.sendMessage({ kind: "getStatus" }).catch(() => null)
  if (resp) render(resp)
}

chrome.storage.local.get("bridgeStatus").then(({ bridgeStatus }) => bridgeStatus && render(bridgeStatus))
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind === "bridgeStatus") render(msg.status)
})
el("refresh").addEventListener("click", refresh)
refresh()
