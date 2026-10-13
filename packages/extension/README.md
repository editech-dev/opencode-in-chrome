# OpenCode in Chrome — extension

Vanilla MV3 extension (zero build step during Fase 0). WXT + Vite migration lands in Fase 1,
when the tool catalog and real bundling arrive.

## Load it (dev)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder (`packages/extension`)
4. Copy the generated extension **ID** from the extension card

## Pair it with the bridge (one time)

```sh
cd packages/bridge
bun run src/cli.ts install --ext-id <the-extension-id>
```

Then **restart Chrome**. Click the extension icon → side panel shows
`Bridge (native host): connected`. Chrome spawns the host automatically from
now on — you never run it by hand.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest — minimal permissions (nativeMessaging, sidePanel, storage, alarms) |
| `background.js` | Service worker: native-messaging port, keep-alive, tool dispatcher (M1) |
| `sidepanel.html/js` | Side panel: bridge status + (M3) OpenCode chat |

## Notes

- `manifest.json` must stay at the package root (it is the unpacked-load root).
- The host name constant must match `HOST_NAME` in `packages/shared` (`com.opencodeinchrome.bridge`).
