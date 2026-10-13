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

> **Status:** `v0.0.1` — Fase 0 scaffold (toolchain, MV3 skeleton, native-messaging spike).
> Browser tools land in Fase 1; MCP integration in Fase 2; side-panel chat in Fase 3.
> See the roadmap in [CONTRIBUTING.md](CONTRIBUTING.md).

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
