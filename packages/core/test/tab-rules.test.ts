import { describe, expect, test } from "bun:test"
import {
  isTabMemberOfGroup,
  isWebViewUrl,
  noGroupError,
  pickLiveEntry,
  foreignTabError,
  shouldEnablePanel,
  urlSchemeError,
  type ScopeGroupEntry,
} from "../src/tab-rules"

describe("isWebViewUrl", () => {
  test("allows http/https only", () => {
    expect(isWebViewUrl("https://example.com")).toBe(true)
    expect(isWebViewUrl("http://localhost:4096")).toBe(true)
  })
  test("refuses privileged/dangerous schemes", () => {
    for (const url of ["chrome://extensions", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "chrome-untrusted://x"]) {
      expect(isWebViewUrl(url)).toBe(false)
    }
  })
  test("refuses garbage", () => {
    expect(isWebViewUrl("not a url")).toBe(false)
  })
})

describe("isTabMemberOfGroup", () => {
  test("accepts members only", () => {
    expect(isTabMemberOfGroup([1, 2, 3], 2)).toBe(true)
    expect(isTabMemberOfGroup([1, 2], 9)).toBe(false)
  })
})

describe("pickLiveEntry", () => {
  const entry: ScopeGroupEntry = { tabGroupId: 42, windowId: 7 }
  test("reuses the stored entry while the group is alive", () => {
    expect(pickLiveEntry(entry, [42, 43])).toBe(entry)
  })
  test("drops stale entries (group closed by user)", () => {
    expect(pickLiveEntry(entry, [43])).toBe(false)
    expect(pickLiveEntry(undefined, [42])).toBe(false)
  })
})

describe("shouldEnablePanel", () => {
  test("inside the OpenCode group → enabled", () => {
    expect(shouldEnablePanel({ id: 1, groupId: 42 }, { groupId: 42 })).toBe(true)
  })
  test("outside the group → disabled (the bug: panel must not follow the user)", () => {
    expect(shouldEnablePanel({ id: 2, groupId: 43 }, { groupId: 42 })).toBe(false)
    expect(shouldEnablePanel({ id: 3, groupId: -1 }, { groupId: 42 })).toBe(false)
  })
  test("before the group exists, only the host tab is enabled", () => {
    expect(shouldEnablePanel({ id: 7 }, undefined, 7)).toBe(true)
    expect(shouldEnablePanel({ id: 8 }, undefined, 7)).toBe(false)
    expect(shouldEnablePanel({ id: 7 }, undefined)).toBe(false)
  })
})

describe("model-visible errors", () => {
  test("foreign tab error mentions the invariant", () => {
    expect(foreignTabError(9, "navigate")).toContain("outside this session's tab group")
  })
  test("no-group error guides the model", () => {
    expect(noGroupError("tabs_create")).toContain("tabs_context")
  })
  test("scheme error names the refusal", () => {
    expect(urlSchemeError("chrome://x")).toContain("http/https")
  })
})
