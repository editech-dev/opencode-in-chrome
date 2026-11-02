import { describe, expect, test } from "bun:test"
import { isPanelSession } from "../src/panel-sessions"

describe("isPanelSession", () => {
  test("accepts IDs recorded by the panel, even after a rename", () => {
    expect(isPanelSession({ id: "ses_1", title: "renamed" }, new Set(["ses_1"]))).toBe(true)
  })
  test("adopts legacy/placeholder/conversation titles", () => {
    expect(isPanelSession({ id: "ses_2", title: "Panel" }, new Set())).toBe(true)
    expect(isPanelSession({ id: "ses_3", title: "Panel 10:30" }, new Set())).toBe(true)
    expect(isPanelSession({ id: "ses_4", title: "Panel — pricing analysis" }, new Set())).toBe(true)
  })
  test("rejects CLI sessions", () => {
    expect(isPanelSession({ id: "ses_5", title: "fix: something" }, new Set())).toBe(false)
    expect(isPanelSession({ id: "ses_6" }, new Set())).toBe(false)
  })
  test("accepts a per-session location matching scratchDir (trailing slash tolerated)", () => {
    const scratch = "/tmp/oc-scratch"
    expect(
      isPanelSession({ id: "ses_7", title: "renamed elsewhere", location: { directory: `${scratch}/` } }, new Set(), scratch),
    ).toBe(true)
    expect(
      isPanelSession({ id: "ses_8", title: "cli", location: { directory: "/tmp/other" } }, new Set(), scratch),
    ).toBe(false)
  })
})
