import { describe, expect, test } from "bun:test"
import {
  isTabMemberOfGroup,
  isWebViewUrl,
  noGroupError,
  pickLiveEntry,
  foreignTabError,
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
