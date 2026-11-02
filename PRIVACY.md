# Privacy Policy

**Effective date:** 2026-11-02

opencode-in-chrome is a local-first browser extension. It does not run a cloud
service and does not include telemetry, analytics or advertising.

## What the extension accesses

- **Page content** (URL, title, visible text, DOM/CDP data) only when a browser
  tool is invoked for the current session.
- **Browser tab metadata** needed to create and manage the session's tab group.
- **Local settings** such as the selected model, agent, panel session IDs and
  connection state, stored with `chrome.storage.local`.
- **Extension status** (connected/disconnected, native host version, MCP client
  count) exchanged with the local native host.

## Where data goes

- The extension talks to `oc-chrome-bridge` over Chrome native messaging. The
  bridge runs on the same machine.
- The bridge listens on loopback only (`127.0.0.1`) and is not exposed to the
  local network.
- OpenCode service credentials are read and used by the native host process.
  They are never sent to the extension or stored in browser storage.
- When you send a prompt, the prompt and any page context you asked the agent to
  read are sent to the **model provider configured in OpenCode**. If that
  provider is a cloud service, its own privacy policy governs that data. The
  opencode-in-chrome project does not add a cloud middleman.

## Redaction and prompt-injection defenses

- Secret patterns (passwords, API keys, tokens) are redacted from tool results
  before they reach the model.
- Page content is framed as data, never as instructions, to reduce prompt
  injection risk.
- Browser tools are gated by OpenCode permissions (`ask` by default in panel
  sessions).

## Data sharing and retention

- The project does not sell, rent or share personal data.
- The project operates no servers that receive user data.
- Local settings remain in Chrome storage until you clear them or uninstall the
  extension.
- Conversation history is managed by your local OpenCode installation.

## Permissions

See the permission table in [README.md](README.md#permissions-and-privacy) for
why each Chrome permission is requested.

## Changes

Material changes to this policy will be published in this file and noted in
[CHANGELOG.md](CHANGELOG.md).

## Contact

Security issues: see [SECURITY.md](SECURITY.md). General privacy questions:
open an issue at <https://github.com/editech-dev/opencode-in-chrome/issues> or
email edisonisaza@gmail.com.
