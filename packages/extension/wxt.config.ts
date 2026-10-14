import { defineConfig } from "wxt"

// Fija el ID de la extensión aunque cambie la carpeta donde se carga (dev).
// El ID deriva de esta clave pública (SHA-256 → a-p): cbhldfhcghehekoofhncmimmngmdmjog.
// La clave PRIVADA vive fuera del repo (~/.config/oc-chrome/ext-key.pem, chmod 600);
// si se pierde, se genera una nueva y hay que re-emparejar con oc-chrome-bridge install.
export default defineConfig({
  manifest: {
    name: "OpenCode in Chrome",
    description:
      "Your local OpenCode agent inside Chrome — chat in the side panel, browser tools over MCP.",
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA44kGUyJHJaRtT4UQdh8thc3m0y+awwdDACwiL+qnX8MRdXyZODi9DK0siJf4Qq0Ctpd5ygp84hc+EeYOI5koC3TVwQzlqX1Djdx6LgD4k+ZRHylyzNZLoW1YbHrngOXWdM/Enhe7MUo3/LhyQU4vsVpWL7KBQnqjRtw0UbC2fvNLsSFXCrkHbJ3GXrPPdeRRl3/YefZGxMNGFqNjJ9WVJS/y5XU1h6UeKTyYpZShtUKRZ4rfJfsP9KhnSQ085U3xTg80q0lVj3O8uaoOkn//y79FxtfCODtajF7RKScFA5wh7LVfcHhFxWCcTCmyB6qBspdJQo4emWvFitgNbobuIQIDAQAB",
    permissions: ["nativeMessaging", "sidePanel", "storage", "alarms", "tabs", "tabGroups", "debugger"],
    side_panel: { default_path: "sidepanel.html" },
    action: { default_title: "OpenCode — open chat panel" },
    minimum_chrome_version: "116",
  },
})
