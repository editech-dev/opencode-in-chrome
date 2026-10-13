/**
 * Pure tab/scope rules — shared by the extension dispatcher (mirrored while the
 * extension is vanilla-JS; consolidation lands with the WXT bundler, TASKS T10)
 * and by the MCP-facing core.
 *
 * Invariant I1 (specs/05): tools never act on tabs outside the session's group.
 * These functions are the single decision point for that, in testable pure form.
 */

export type SessionGroupId = number

export type ScopeGroupEntry = {
  tabGroupId: number
  windowId: number
}

/** True when a URL may be used by navigate/tabs_create (no chrome:, file:, etc.). */
export function isWebViewUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * Membership rule: a tool may act on a tab only when the tab belongs to the
 * session's tab group across ANY window group change we are aware of.
 */
export function isTabMemberOfGroup(tabIds: readonly number[], tabId: number): boolean {
  return tabIds.includes(tabId)
}

/** Which entry to reuse for a session, or false when none/gone. */
export function pickLiveEntry(entry: ScopeGroupEntry | undefined, liveGroupIds: readonly number[]): ScopeGroupEntry | false {
  if (!entry) return false
  return liveGroupIds.includes(entry.tabGroupId) ? entry : false
}

/** Error text used when a tool receives a foreign tab (typed, model-visible). */
export function foreignTabError(tabId: number, tool: string): string {
  return `${tool}: tab ${tabId} is outside this session's tab group — call tabs_context first; isolation is enforced (I1)`
}

/** Error text when a session has no group yet and createIfEmpty was not set. */
export function noGroupError(tool: string): string {
  return `${tool}: no tab group for this session yet — call tabs_context with createIfEmpty:true first`
}

/** Deny-list reminder: schemes outside http(s) are always refused, even on allowlisted hosts. */
export function urlSchemeError(url: string): string {
  return `navigate: scheme refused "${url}" — only http/https through agent tools`
}
