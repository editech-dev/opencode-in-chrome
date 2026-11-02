# Chrome Web Store submission notes

Internal checklist for the maintainer and reviewer notes for the store listing.

## Single purpose

opencode-in-chrome lets the user run their own local OpenCode agent inside
Chrome: a side-panel chat plus browser tools that act only inside a tab group
created for the active OpenCode session.

## Reviewer test instructions

The extension has a companion native host (`oc-chrome-bridge`) that must be
installed on the same machine. Without it, the side panel shows a neutral
"bridge disconnected" state; no browser action is performed.

To test the full flow:

1. Install Bun ≥ 1.4 and OpenCode V2.
2. From the project repository, run:
   ```sh
   bun install --frozen-lockfile
   bun run build:ext
   bun run packages/bridge/src/cli.ts install --ext-id <extension-id>
   bun run packages/bridge/src/cli.ts mcp
   opencode service start
   ```
3. Open the side panel from the extension icon and create a chat.
4. Ask the agent to read the current page, click a link, or take a screenshot.

The bridge listens on loopback only and is spawned by Chrome through native
messaging. It does not open a network port to the LAN.

## Permission justifications

| Permission | Justification |
|---|---|
| `nativeMessaging` | Connects to the local `oc-chrome-bridge` host that performs browser actions and serves the side-panel chat. |
| `sidePanel` | Displays the OpenCode chat UI. |
| `storage` | Persists local settings, panel session IDs and bridge status. |
| `alarms` | Keeps the MV3 service worker alive and reconnects the native host after restarts. |
| `tabs` | Reads the active tab URL/title and manages per-session tab groups. |
| `tabGroups` | Isolates each OpenCode session from the user's other tabs. |
| `debugger` | Uses the Chrome DevTools Protocol to click, type, scroll, screenshot and read page text in the active tab. |

## Data use

- No analytics, telemetry, ads or remote code.
- Page content is processed only when the user invokes a browser tool.
- Page content and prompts are sent to the model provider configured by the user
  in OpenCode; the extension itself has no backend.
- See [PRIVACY.md](PRIVACY.md).

## Release artifacts

- Store ZIP: `bun run build:store` → `packages/extension/.output/*-store.zip`.
  The build removes the development `key`; `manifest.json` is at the ZIP root.
- Development build: `bun run build:ext` → `packages/extension/.output/chrome-mv3`
  (keeps the pinned development key for unpacked loading).
- Icons: `packages/extension/public/icon/{16,32,48,96,128}.png`.
- Still required in the dashboard: at least one screenshot (1280×800 or
  640×400), a 440×280 promo tile, and the privacy policy URL (this repository's
  `PRIVACY.md` rendered on GitHub).
