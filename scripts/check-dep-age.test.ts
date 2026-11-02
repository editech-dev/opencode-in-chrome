import { describe, expect, test } from "bun:test"
import { MIN_AGE_MS, extractResolvedPackages, isTooFresh } from "./check-dep-age"

const LOCK_FIXTURE = `
{
  "lockfileVersion": 2,
  "packages": {
    "entities": ["entities@7.0.1", "", {}, "sha512-aaa"],
    "htmlparser2/entities": ["entities@8.1.0", "", {}, "sha512-bbb"],
    "domhandler/entities": ["entities@4.5.0", "", {}, "sha512-ccc"],
    "other": ["other@1.0.0", "", {}, "sha512-ddd"]
  }
}
`

describe("extractResolvedPackages", () => {
  test("checks every version of a duplicated package", () => {
    const resolved = extractResolvedPackages(LOCK_FIXTURE)
    const entities = resolved
      .filter((p) => p.name === "entities")
      .map((p) => p.version)
      .sort()
    expect(entities).toEqual(["4.5.0", "7.0.1", "8.1.0"])
    expect(resolved).toHaveLength(4)
  })

  test("deduplicates identical name@version entries", () => {
    const resolved = extractResolvedPackages(LOCK_FIXTURE + LOCK_FIXTURE)
    expect(resolved).toHaveLength(4)
  })
})

describe("isTooFresh", () => {
  const now = Date.UTC(2026, 10, 2, 12)

  test("blocks a version published less than 24h ago", () => {
    expect(isTooFresh(now - (MIN_AGE_MS - 1), now)).toBe(true)
  })

  test("allows a version published at least 24h ago", () => {
    expect(isTooFresh(now - MIN_AGE_MS, now)).toBe(false)
  })
})
