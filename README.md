# opencode-in-chrome

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
> See the roadmap in [CONTRIBUTING.md](CONTRIBUTING.md).

## Use with OpenCode (Mode A)

```sh
# one-time: pair the extension + register the MCP server globally
bun run packages/bridge/src/cli.ts install --ext-id <extension-id-from-chrome://extensions>
bun run packages/bridge/src/cli.ts mcp
```

Then in any OpenCode session the agent can ask for `oc-chrome_tabs_context`,
`oc-chrome_navigate`, `oc-chrome_get_page_text`, `oc-chrome_computer`, … and every
browser action runs in **a tab group dedicated to that session** — isolated from
your own tabs, gone when the session ends. Gate the tools as you see fit
(`permissions` snippet in [packages/bridge/README.md](packages/bridge/README.md);
the permission key keeps the server dash: `oc-chrome_*`).

## Side-panel chat

The panel talks to the same local OpenCode background service as your CLI.
Start it before opening the panel (or keep `opencode` running in a terminal).
Open the panel from the extension icon on the tab you want it attached to:

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

## Requirements

| | Version |
|---|---|
| [Bun](https://bun.com) | ≥ 1.4 (pinned in `.bun-version`) |
| Chrome / Chromium / Edge / Brave | MV3 (Chrome ≥ 116) |
| OpenCode | V2, with the shared background service ([start it here](#side-panel-chat)) |

## Development

```sh
bun install
bun test
```

Spanish docs: [README.es.md](README.es.md) · Security policy: [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE) — donated to everyone.
