# Contributing

Thanks for helping build opencode-in-chrome. Short rules, strictly enforced:

## Git

- **Never auto-commit.** Commits require an explicit request in the current message
  ("commit", "git commit"). "ok", "done", "ship" are **not** confirmations.
- Conventional commits: `feat|fix|docs|refactor|test|chore(scope): message`, subject ≤ 72 chars,
  body explains *why*.
- Stage files **by name**; never `git add -A` / `git add .` unless you reviewed every file.
- Never `--no-verify`, never amend pushed commits, never force-push, never commit directly to `main`.
- Pushing is a separate explicit step from committing.

## Stack & workflow

- **Bun ≥ 1.4** (`bun install`, `bun test`, `bun run typecheck`). Do not add Node-only tooling.
- **Dependency policy:** no package version younger than **24 h** (CI enforces it). No
  lifecycle/postinstall scripts (`trustedDependencies: []`) — if a package truly needs one,
  justify it in a one-line ADR before adding it to the trust list.
- **Store builds:** `bun run build:store` produces the Chrome Web Store ZIP (no development
  `key`). Never upload the `build:ext` output; it is for unpacked development only.
- Work happens in feature branches (`feat/…`, `fix/…`) and PRs; `main` is protected.

## Project layout

- `packages/extension` — MV3 Chrome extension (side panel, service worker dispatcher).
- `packages/bridge` — `oc-chrome-bridge`: native messaging host + MCP server (stdio & HTTP).
- `packages/core` — browser-tool catalog (one file per tool: spec, implementation, test).
- `packages/shared` — wire protocol, types, redaction utilities.

Internal working docs (specs/, design/, docs/, .opencode/) are **not part of the published repo**
(see `.gitignore`) — keep improvements to them local.

## Reporting issues

Bug reports welcome via GitHub Issues. Security issues: follow [SECURITY.md](SECURITY.md) — do not open public issues for them.
