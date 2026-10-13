/**
 * The v0.1 tool catalog — mirrors specs/04-catalogo-herramientas.md.
 *
 * Fase 1 implements `inFase1: true`; the rest is backlog ordered by demand.
 * Names intentionally mirror the "Claude in Chrome" catalog (community-documented)
 * so muscle memory and prompts transfer — without copying any of its code.
 */

import type { ToolDefinition } from "../registry"

export const CATALOG: ToolDefinition[] = [
  {
    name: "tabs_context",
    title: "Tab group context",
    description:
      "Lists the tabs of this session's Chrome tab group; with createIfEmpty, creates the group (new window + tab). Must be the first call of a session.",
    inputSchema: { type: "object", properties: { createIfEmpty: { type: "boolean" } } },
    risk: "read_only",
    inFase1: true,
  },
  {
    name: "tabs_create",
    title: "Create tab in group",
    description: "Opens a new tab inside the session's tab group, optionally at a URL.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, active: { type: "boolean" } } },
    risk: "read_only",
    inFase1: true,
  },
  {
    name: "tabs_close",
    title: "Close tab in group",
    description: "Closes a tab that belongs to the session's tab group (refuses foreign tabs).",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] },
    risk: "mutates_page",
    inFase1: true,
  },
  {
    name: "navigate",
    title: "Navigate tab",
    description: "Navigates a group tab to a URL (allowlist + sensitive-action checks apply).",
    inputSchema: { type: "object", properties: { url: { type: "string" }, tabId: { type: "number" } }, required: ["url"] },
    risk: "read_only",
    inFase1: true,
  },
  {
    name: "computer",
    title: "Computer use actions",
    description:
      "One tool, many actions: screenshot, left_click, right_click, double_click, triple_click, left_click_drag, scroll, type, key, hover, wait. Coordinates refer to the last screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["screenshot", "left_click", "right_click", "double_click", "triple_click", "left_click_drag", "scroll", "type", "key", "hover", "wait"] },
        tabId: { type: "number" },
        coordinates: { type: "object" },
        text: { type: "string" },
        scrollDirection: { type: "string" },
        scrollAmount: { type: "number" },
        durationMs: { type: "number" },
      },
      required: ["action"],
    },
    risk: "mutates_page",
    inFase1: true,
  },
  {
    name: "read_page",
    title: "Accessibility tree",
    description: "Returns the page's accessibility tree with stable element refs for click/type targeting.",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } } },
    risk: "read_only",
    inFase1: true,
  },
  {
    name: "get_page_text",
    title: "Page text",
    description: "Extracts the page's visible text content (with redaction applied).",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } } },
    risk: "read_only",
    inFase1: true,
  },
  {
    name: "find",
    title: "Find elements",
    description: "Searches the page for elements matching text/role and returns their refs.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, tabId: { type: "number" } }, required: ["query"] },
    risk: "read_only",
    inFase1: true,
  },
  {
    name: "form_input",
    title: "Fill form field",
    description: "Fills or selects a form field by ref or selector (validation-aware, events fired).",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, selector: { type: "string" }, value: { type: "string" }, tabId: { type: "number" } }, required: ["value"] },
    risk: "mutates_page",
    inFase1: true,
  },
  {
    name: "javascript_tool",
    title: "Evaluate JS in page",
    description:
      "Runs JavaScript in the page context (Runtime.evaluate, replMode). Output is secret-redacted; requires confirmation on allowlisted-but-sensitive flows.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, tabId: { type: "number" } }, required: ["text"] },
    risk: "sensitive",
    inFase1: true,
  },
  {
    name: "browser_batch",
    title: "Batch actions",
    description: "Runs multiple actions sequentially in one round trip; stops at first error; no nesting.",
    inputSchema: { type: "object", properties: { actions: { type: "array", items: { type: "object" } } }, required: ["actions"] },
    risk: "mutates_page",
    inFase1: false,
  },
  {
    name: "read_console_messages",
    title: "Console messages",
    description: "Reads console output (errors/warnings/logs) from a group tab — the dev-loop tool.",
    inputSchema: { type: "object", properties: { tabId: { type: "number" }, level: { type: "string" } } },
    risk: "read_only",
    inFase1: false,
  },
  {
    name: "read_network_requests",
    title: "Network requests",
    description: "Lists captured network requests (and bodies when available) for a group tab.",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } } },
    risk: "read_only",
    inFase1: false,
  },
  {
    name: "resize_window",
    title: "Resize window",
    description: "Resizes the window that owns a group tab (keeps screenshot coordinates sane).",
    inputSchema: { type: "object", properties: { width: { type: "number" }, height: { type: "number" }, tabId: { type: "number" } }, required: ["width", "height"] },
    risk: "mutates_page",
    inFase1: false,
  },
]

export const FASE1_TOOLS = CATALOG.filter((t) => t.inFase1)
