/**
 * Keyboard navigation for the inline permission card (specs/07 UX).
 *
 * The card defaults to the safe "once" choice; ←/→ move across the three
 * decisions and wrap at the ends (clamp, never wrap around to the opposite
 * extreme). Pure and shared with tests — the panel only renders the result.
 */

export type PermissionDecision = "once" | "always" | "reject"

export const PERMISSION_ORDER: readonly PermissionDecision[] = ["once", "always", "reject"]

export function movePermissionDecision(
  current: PermissionDecision,
  key: "ArrowLeft" | "ArrowRight",
): PermissionDecision {
  const idx = PERMISSION_ORDER.indexOf(current)
  const delta = key === "ArrowRight" ? 1 : -1
  const next = Math.max(0, Math.min(PERMISSION_ORDER.length - 1, idx + delta))
  return PERMISSION_ORDER[next] ?? "once"
}
