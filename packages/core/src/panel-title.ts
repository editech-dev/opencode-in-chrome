/**
 * Panel chat titles (specs/10): "Panel — <topic>" from the first user prompt.
 *
 * The panel creates sessions with `Panel <time>`; the first prompt replaces it
 * with something the history list can actually distinguish. Pure helpers so the
 * truncation and the page-context prefix are testable without the DOM.
 */

const CONTEXT_PREFIX = /^\[contexto:[^\]]*\]\s*/i

/** True for the placeholder titles the panel itself writes. */
export function isDefaultPanelTitle(title: string): boolean {
  return /^Panel( \d{1,2}:\d{2})?$/.test(title.trim())
}

/** "Panel — topic" from the user prompt; strips the page-context prefix. */
export function panelTitleFromPrompt(text: string, max = 60): string {
  const clean = text.replace(CONTEXT_PREFIX, "").replace(/\s+/g, " ").trim()
  if (!clean) return "Panel"
  const clipped = clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
  return `Panel — ${clipped}`
}
