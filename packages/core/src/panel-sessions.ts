/**
 * Panel-history membership (specs/10).
 *
 * The Chrome panel must show only chats it created. Two signals keep CLI
 * sessions out when the directory query cannot be trusted:
 *   1. the ID set persisted by the panel (survives renames/restarts);
 *   2. the panel's title convention (`Panel`, `Panel <time>`, `Panel — topic`).
 */

export type PanelSessionLike = {
  id: string
  title?: string
  location?: { directory?: string }
}

function normalizeDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  return trimmed === "" ? "/" : trimmed
}

export function isPanelSession(
  session: PanelSessionLike,
  panelIds: ReadonlySet<string>,
  scratchDir?: string,
): boolean {
  if (panelIds.has(session.id)) return true
  const title = (session.title ?? "").trim()
  if (title === "Panel" || title.startsWith("Panel ")) return true
  // Per-session location is a trustworthy marker (unlike the listing envelope,
  // which some servers echo without filtering). Recovers renamed legacy chats.
  const dir = session.location?.directory
  return scratchDir !== undefined && dir !== undefined && normalizeDir(dir) === normalizeDir(scratchDir)
}
