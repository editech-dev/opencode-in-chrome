/** Side panel — bridge status + (M3) OpenCode chat. */

const el = (id) => document.getElementById(id)

function render(status) {
  const dot = (cls) => `<span class="dot ${cls}"></span>`
  const state = el("bridge-state")
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

// While the panel is open, poll the SW every 5 s: each message resets the MV3
// idle timer, keeping the SW (and with it the native host) alive during use.
setInterval(refresh, 5_000)
refresh()
