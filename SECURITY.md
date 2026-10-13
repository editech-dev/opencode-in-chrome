# Security Policy

## Supported versions

Only the latest release tag receives security fixes.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Email: edisonisaza@gmail.com (include "opencode-in-chrome" in the subject). You will get an
acknowledgement within 7 days and a fix or a mitigation plan within 30 days for accepted reports.

## Scope

In scope:

- `packages/bridge` — native messaging host, local socket/pipe server, MCP server, OpenCode proxy.
- `packages/extension` — service worker dispatcher, side panel, content scripts, options page.
- `packages/shared` — wire protocol, redaction logic.
- `infra/installer` and the `oc-chrome-bridge` CLI (`install`, `uninstall`, `doctor`).

Out of scope: OpenCode itself, Bun runtime, Chrome, third-party MCP servers, this repository's
static content.

## Key invariants we treat as vulnerabilities if broken

1. Tools must **never** act on tabs outside the session's Chrome tab group.
2. Local bridge endpoints must reject unauthenticated/unpaired clients.
3. Secret values (passwords, tokens, API keys) must be redacted from tool results.
4. The user's `oc_sk_` key or any provider key must never be stored in browser storage or the repo.
5. Actions classified as sensitive (purchases, deletions, publishing, PII submissions) must never
   execute without an explicit user confirmation.

## Threat model summary

Browser agents are exposed to prompt injection (hidden instructions in page content). The
extension frames all page content as data, not instructions, and the bridge redacts secrets from
results. Site allowlists and sensitive-action confirmations are enforced independently of the
agent's mode.
