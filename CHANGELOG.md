# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-alpha] — 2026-11-02

### Fixed
- Side panel now distinguishes the native bridge from the local OpenCode service: when the
  service is down it shows a neutral notice with `opencode service start`, disables the composer,
  and reconnects within 5 s without creating an empty session.
- Side panel is scoped to its OpenCode tab group: removed `side_panel.default_path` (global
  panel), per-tab enable/disable, the host tab joins the group, and the chat is restored per
  window.
- The panel history (⟲) is scoped to the panel's scratch directory with a fallback
  to the panel's own session markers; the "todas" toggle that exposed CLI sessions is gone.
- Panel sessions get a conversation title (`Panel — <first prompt>`) instead of every entry
  being called "Panel".

### Changed
- Docs: the permission key is `oc-chrome_*` (server dash preserved), and rule ordering is
  documented (`last match wins`; denies last).
- Publication metadata now points at `github.com/editech-dev/opencode-in-chrome`; the README
  gained a real quickstart, permission/privacy tables and model credits.

### Added
- Keyboard support for permission cards: Enter accepts "once", ←/→ selects
  "always"/"reject", Enter confirms; visible shortcut hint.
- `bun run build:store`: a Chrome Web Store ZIP that strips the development `key` (the store
  assigns its own ID) while `build:ext` keeps the pinned ID for unpacked development.
- Portable panel scratch directory: the native host derives `~/opencode-chrome` from the
  current user instead of a hardcoded path.
- `PRIVACY.md` and `STORE.md` for store review and data-use disclosure.

## [0.0.1] — 2026-10-13

### Added
- Monorepo scaffold on Bun 1.4 (workspaces: extension, bridge, core, shared).
- Wire-protocol package: 4-byte LE + JSON frame codec (Chrome native messaging compatible),
  message types with correlation ids and session scoping, secret redaction utility.
- Native messaging host spike (`oc-chrome-bridge`): ping/pong + status handshake, local
  socket/pipe listener for MCP clients (Node-compatible core, Bun-first runtime).
- Bridge CLI: `install` / `uninstall` / `status` / `doctor` (Linux, macOS, Windows registry).
- Vanilla MV3 extension skeleton: side panel with connection status, service worker with
  `connectNative` + keep-alive + reconnection backoff (loadable unpacked, zero build step).
- Supply-chain policy: 24h minimum package age (Renovate `minimumReleaseAge` + CI gate script),
  `trustedDependencies: []`, frozen-lockfile install, `bun audit`.
- CI matrix on ubuntu/macos/windows: typecheck, tests, dependency-age gate, audit.
