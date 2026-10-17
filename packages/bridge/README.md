# @opencode-in-chrome/bridge — `oc-chrome-bridge`

The bridge between OpenCode and your Chrome. Published to npm in Fase 5.

- `src/native-host/host.ts` — Chrome spawns this (native messaging): 4B-LE+JSON
  framing on stdio, local socket/pipe for MCP clients, multiplexed tool relay.
- `src/mcp/server.ts` + `src/mcp/relay.ts` — the MCP server (T12): JSON-RPC over
  stdio or Streamable HTTP → socket relay → extension dispatch. One MCP process
  per OpenCode session = one Chrome tab group (isolation I1).
- `src/cli.ts` — `install` / `uninstall` / `status` / `doctor` / `mcp`.

```sh
bun run src/cli.ts status
bun run src/cli.ts install --ext-id <extension-id>
bun run src/cli.ts doctor            # now also probes the MCP setup (T16)
bun run src/cli.ts mcp               # registers oc-chrome with OpenCode (global)
```

## Use with OpenCode (Modo A)

The MCP layer exposes the browser as `oc_chrome_*` tools (OpenCode normalizes
the server name + tool name). Registering:

```sh
oc-chrome-bridge mcp                 # → opencode mcp add oc-chrome --global -- bun run …/mcp.ts
oc-chrome-bridge mcp --http          # alternative: shared loopback gateway (POST /mcp on :9600)
```

Transports:

- **stdio** (default, per-session): OpenCode spawns `packages/bridge/src/mcp.ts`
  as it does any local MCP server. `sessionId` is stable per process, so the
  tab group persists across the whole session and disappears with it.
- **Streamable HTTP** (`bun run packages/bridge/src/mcp.ts --http`): stateless
  JSON-RPC on `http://127.0.0.1:9600/mcp`, loopback-only, for one shared
  browser gateway across projects. Pass the port as `--http 9630`.

Permissions — the browser is an agent hand, so gate it (paste into
`~/.config/opencode/opencode.jsonc` under `permissions`):

```jsonc
{ "action": "oc_chrome_*", "resource": "*", "effect": "ask" }
// After you trust it day-to-day you may soften the read-only family:
// { "action": "oc_chrome_tabs_*",   "resource": "*", "effect": "allow" },
// { "action": "oc_chrome_get_page_text", "resource": "*", "effect": "allow" }
```

Secrets never leave the socket in the clear: every text payload crosses the
relay through the shared `redactAll()` pass (I3) — the MCP content your model
sees shows `[REDACTED]` where a secret pattern was matched.

`bun test` in this package includes the 3-OS handshake gate (Fase 0 spike) and
the MCP contract suite (initialize negotiation, live-tool listing, id-matched
multiplexing, timeout shape) — T12.
