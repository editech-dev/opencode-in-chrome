# opencode-in-chrome

[![CI](https://github.com/editech-dev/opencode-in-chrome/actions/workflows/ci.yml/badge.svg)](https://github.com/editech-dev/opencode-in-chrome/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Your local [OpenCode](https://opencode.ai) agent, living inside Chrome.**

A free, open alternative to "Claude in Chrome": an MV3 side-panel extension where
your **own OpenCode installation** (the same sessions, skills, agents and models you
already use in the CLI) can read pages, navigate, click, type, fill forms and
automate multi-step tasks in **your browser, with your logins**.

```
OpenCode (CLI or local server) ──MCP──▶ oc-chrome-bridge ──native messaging──▶ Chrome extension
```

- **Mode A — agent**: your OpenCode drives the browser through the `oc-chrome` MCP server.
- **Mode B — chat**: an OpenCode chat in the Chrome side panel, sharing sessions with your CLI, both ways.

Everything runs on **your machine**: no cloud middleman, no Docker required, no scripts to run per use
(Chrome spawns the bridge automatically; you install it once).

> **Status:** `v0.1.0-alpha` — Mode A (MCP) is live and Mode B (side-panel chat)
> shares sessions with your CLI. The panel needs the local OpenCode background
> service running; see [Side-panel chat](#side-panel-chat).
> See [CHANGELOG.md](CHANGELOG.md) for what changed.

## Install from source

Requirements: Bun ≥ 1.4, Chrome/Chromium/Edge/Brave ≥ 116, and OpenCode V2 with
the shared background service.

```sh
git clone https://github.com/editech-dev/opencode-in-chrome.git
cd opencode-in-chrome
bun install --frozen-lockfile
bun run build:ext
```

Then load the extension:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `packages/extension/.output/chrome-mv3`.
3. Copy the extension **ID** from the extension card.

Pair the extension with the native bridge and register the MCP server:

```sh
bun run packages/bridge/src/cli.ts install --ext-id <extension-id-from-chrome://extensions>
bun run packages/bridge/src/cli.ts mcp
```

Finally, start the OpenCode service used by the side panel:

```sh
opencode service status
opencode service start   # if it is not running
```

The source build pins the extension ID with a development key
(`cbhldfhcghehekoofhncmimmngmdmjog`). If Chrome shows a different ID, use the one
shown in `chrome://extensions`.

> **Chrome Web Store builds:** the store assigns its own ID. The store ZIP is
> built with `bun run build:store`, which intentionally omits the development
> `key`. Use the ID shown by the store listing when running `install --ext-id`.

## Use with OpenCode (Mode A)

After `oc-chrome-bridge mcp`, any OpenCode session can ask for
`oc-chrome_tabs_context`, `oc-chrome_navigate`, `oc-chrome_get_page_text`,
`oc-chrome_computer`, … Every browser action runs in **a tab group dedicated to
that session** — isolated from your own tabs, gone when the session ends.

Gate the tools as you see fit (permissions snippet in
[packages/bridge/README.md](packages/bridge/README.md); the permission key keeps
the server dash: `oc-chrome_*`).

## Side-panel chat

The panel talks to the same local OpenCode background service as your CLI.
Start it before opening the panel (or keep `opencode` running in a terminal):

```sh
opencode service status
opencode service start   # if it is not running
```

If it is not running, the panel shows a neutral notice with this command — no
error, and it reconnects on its own when the service comes up.

If you use `opencode --standalone` or disabled the shared service
(`opencode service set disabled true`), the panel cannot connect.

The panel creates its sessions with an `oc-chrome_*` → `ask` ruleset, so the
browser tools are gated without editing your OpenCode config. If you also use
Mode A from the CLI and want a global gate, see the permissions snippet in
[packages/bridge/README.md](packages/bridge/README.md).

## Permissions and privacy

The extension asks for the minimum Chrome permissions needed to be a browser
hand. There are no host permissions and no content scripts on every page.

| Permission | Why it is needed |
|---|---|
| `nativeMessaging` | Talk to `oc-chrome-bridge`, the local host Chrome spawns on your machine. |
| `sidePanel` | Show the OpenCode chat in Chrome's side panel. |
| `storage` | Keep local settings, panel session IDs and connection state. |
| `alarms` | Keep the MV3 service worker alive and reconnect the bridge with backoff. |
| `tabs` | Read the active tab's URL/title and manage per-session tab groups. |
| `tabGroups` | Isolate each OpenCode session in its own Chrome tab group. |
| `debugger` | Attach to the active tab through the DevTools Protocol to click, type, scroll, take screenshots and read page text. |

What stays local:

- No telemetry, analytics, ads or remote code. The extension only talks to the
  local native bridge over Chrome native messaging.
- The bridge listens on loopback only and never exposes the browser to your LAN.
- OpenCode service credentials stay in the native host process; the extension
  never sees them.
- Page content is treated as **data, not instructions**, and secret patterns are
  redacted before tool results reach the model.
- Browser tools are gated by OpenCode permissions (`ask` by default in panel
  sessions).

One honest exception: when you ask the agent to read a page, that page content
goes to the **model provider configured in OpenCode**. If that provider is
cloud-hosted, its privacy policy applies. The project itself does not add a
cloud middleman.

See [PRIVACY.md](PRIVACY.md) for the full policy.

## Requirements

| | Version |
|---|---|
| [Bun](https://bun.com) | ≥ 1.4.4 (pinned in `.bun-version`) |
| Chrome / Chromium / Edge / Brave | MV3 (Chrome ≥ 116) |
| OpenCode | V2, with the shared background service ([start it here](#side-panel-chat)) |

## Development

```sh
bun install
bun test
bun run typecheck
bun run build:ext     # dev/unpacked build (keeps the pinned dev key)
bun run build:store   # store ZIP (removes the dev key; ready for Chrome Web Store)
```

The store ZIP is written under `packages/extension/.output/` with
`manifest.json` at the archive root. Never upload the unpacked development
directory as-is.

Spanish docs: [README.es.md](README.es.md) · Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) ·
Security: [SECURITY.md](SECURITY.md) · Privacy: [PRIVACY.md](PRIVACY.md)

## Built with

Built with [OpenCode](https://opencode.ai) using **GLM 5.3 Flash** and
**DeepSeek V4.1 Flash**.

## License

[MIT](LICENSE) — free for everyone.
