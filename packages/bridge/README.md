# @opencode-in-chrome/bridge — `oc-chrome-bridge`

The bridge between OpenCode and your Chrome. Published to npm in Fase 5.

- `src/native-host/host.ts` — Chrome spawns this (native messaging): 4B-LE+JSON
  framing on stdio, local socket/pipe for MCP clients, multiplexed tool relay.
- `src/cli.ts` — `install` / `uninstall` / `status` / `doctor` (one-time setup).

```sh
bun run src/cli.ts status
bun run src/cli.ts install --ext-id <extension-id>
bun run src/cli.ts doctor
```

`bun test` in this package includes the 3-OS handshake gate (Fase 0 spike).
