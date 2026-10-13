# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

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
