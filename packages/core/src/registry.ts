/**
 * Tool contract for the opencode-in-chrome catalog.
 *
 * Rule (D5): every tool has a ficha in specs/04-catalogo-herramientas.md before it
 * is implemented. One file per tool in src/tools/: spec comment, implementation,
 * unit test.
 */

import type { SessionScope, ToolContent } from "@opencode-in-chrome/shared"

export type RiskLevel = "read_only" | "mutates_page" | "sensitive"

export type ToolDefinition = {
  /** MCP-visible name; OpenCode normalizes to `oc_chrome_<name>`. */
  name: string
  title: string
  description: string
  /** JSON Schema for args (zod schema compiled in Fase 1). */
  inputSchema: Record<string, unknown>
  risk: RiskLevel
  /** true → included in the Fase 1 catalog; false → backlog. */
  inFase1: boolean
  /** true → the extension SW dispatcher implements this tool TODAY (MCP lists only these). */
  live?: boolean
}

export type ToolContext = {
  scope: SessionScope
  /** Call the extension service worker and wait for its response. */
  dispatch: (tool: string, args: unknown) => Promise<{ content: ToolContent[] }>
}

export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<{ content: ToolContent[] }>
