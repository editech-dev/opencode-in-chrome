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

> **Status:** `v0.1.0-alpha` — Fase 1 shipped: the extension drives your Chrome
> (tabs, navigation, page text, full computer use) and the **MCP server is live**:
> register it once with `oc-chrome-bridge mcp` and your OpenCode sessions get the
> `oc_chrome_*` browser tools. Side-panel chat (Fase 3) is next.
> See the roadmap in [CONTRIBUTING.md](CONTRIBUTING.md).

## Use with OpenCode (Mode A)

```sh
# one-time: pair the extension + register the MCP server globally
bun run packages/bridge/src/cli.ts install --ext-id <extension-id-from-chrome://extensions>
bun run packages/bridge/src/cli.ts mcp
```

Then in any OpenCode session the agent can ask for `oc_chrome_tabs_context`,
`oc_chrome_navigate`, `oc_chrome_get_page_text`, `oc_chrome_computer`, … and every
browser action runs in **a tab group dedicated to that session** — isolated from
your own tabs, gone when the session ends. Gate the tools as you see fit
(`permissions` snippet in [packages/bridge/README.md](packages/bridge/README.md)).

## Requirements

| | Version |
|---|---|
| [Bun](https://bun.com) | ≥ 1.4 (pinned in `.bun-version`) |
| Chrome / Chromium / Edge / Brave | MV3 (Chrome ≥ 116) |
| OpenCode | V2, with `opencode serve` / background service |

## Development

```sh
bun install
bun test
```

Spanish docs: [README.es.md](README.es.md) · Security policy: [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE) — donated to everyone.
