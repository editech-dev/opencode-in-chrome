import { describe, expect, test } from "bun:test"
import { movePermissionDecision } from "../src/perm-nav"

describe("movePermissionDecision", () => {
  test("starts on once and moves right", () => {
    expect(movePermissionDecision("once", "ArrowRight")).toBe("always")
    expect(movePermissionDecision("always", "ArrowRight")).toBe("reject")
  })
  test("moves left", () => {
    expect(movePermissionDecision("reject", "ArrowLeft")).toBe("always")
    expect(movePermissionDecision("always", "ArrowLeft")).toBe("once")
  })
  test("clamps at the ends (no wrap-around)", () => {
    expect(movePermissionDecision("once", "ArrowLeft")).toBe("once")
    expect(movePermissionDecision("reject", "ArrowRight")).toBe("reject")
  })
})
