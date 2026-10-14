# OpenCode in Chrome — extension

WXT (Vite) MV3 extension. Entrypoints live in `entrypoints/`; the SW is bundled
together with `@opencode-in-chrome/*` workspace modules (no mirrored logic).

## Develop

```sh
bun run build:ext     # desde la raíz del repo → packages/extension/.output/chrome-mv3 (WXT fijado: 0.21.4)
bun run --cwd packages/extension dev   # live-reload para desarrollo
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `packages/extension/.output/chrome-mv3`
4. Copy the generated extension **ID** from the extension card

## Pair it with the bridge (one time)

```sh
bun run packages/bridge/src/cli.ts install --ext-id <the-extension-id>
```

`install` unions every `--ext-id` flag with previously saved ids — loading a
rebuilt unpacked extension changes its ID (hash of the folder path), and the
manifest keeps serving the old pairing until you decide otherwise. Then hit
**↻** in the side panel (or wait ≤30 s for the keep-alive alarm): the panel
shows `Bridge (native host): connected`. Chrome spawns the host automatically
from now on — you never run it by hand.

## Files

| File | Purpose |
|---|---|
| `wxt.config.ts` | Manifest source (permissions, side panel, action, minimum chrome) |
| `entrypoints/background.ts` | Service worker: native-messaging port, keep-alive, tool dispatcher (M1) |
| `entrypoints/sidepanel/` | Side panel: bridge status + (M3) OpenCode chat |

## Notes

- The packed load root is `.output/chrome-mv3` (build output, gitignored).
- The host name constant must match `HOST_NAME` in the bridge (`com.opencodeinchrome.bridge`).
- `bun run build:ext` inlines `@opencode-in-chrome/shared` (redaction) and
  `core` (tab rules, key specs) — the extension ships no runtime deps.
- The build runs the workspace-pinned `wxt` (0.21.4) — never `bunx wxt@latest`
  (unpinned latest violates the supply-chain policy D4).
