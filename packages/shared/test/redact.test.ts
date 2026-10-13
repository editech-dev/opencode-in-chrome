import { describe, expect, test } from "bun:test"
import { redactAll, redactJsonSecrets, redactSecrets } from "../src/redact"
import { redactSecrets as _unusedTypeGuard } from "../src/redact"

describe("redactSecrets — I3 (tool results must not leak secrets)", () => {
  test("redacts key: value pairs with sensitive keys", () => {
    const out = redactSecrets("password: hunter2\napiKey=sk-1234567890\nnormal: value")
    expect(out).toContain("password: [REDACTED]")
    expect(out).toContain("apiKey: [REDACTED]") // normalized to ": " by our replacement
    expect(out).toContain("normal: value")
    expect(out).not.toContain("hunter2")
    expect(out).not.toContain("sk-1234567890")
  })

  test("case-insensitive and hyphenated variants", () => {
    const out = redactSecrets("Authorization-Token: abc123")
    expect(out).not.toContain("abc123")
    expect(out).toContain("[REDACTED]")
  })

  test("keeps the key visible, only the value is redacted", () => {
    const out = redactSecrets("api_key = supersecret-value\n")
    expect(out).toContain("api_key")
    expect(out).not.toContain("supersecret-value")
  })
})

describe("redactJsonSecrets", () => {
  test("redacts JSON-shaped pairs", () => {
    const out = redactJsonSecrets('{"username":"e","token":"aaaa-bbbb","n":1}')
    expect(out).not.toContain("aaaa-bbbb")
    expect(out).toContain('"token"')
    expect(out).toContain('"n":1')
  })
})

describe("redactAll — passes sounding pages", () => {
  test("ordinary words survive untouched", () => {
    const body = "Welcome to Example Domain this domain is for illustration"
    expect(redactAll(body)).toContain(body)
  })
  test("mixed page text with a password is cleaned", () => {
    const body = "Welcome!\npassword: letmein\nBye"
    expect(redactAll(body)).not.toContain("letmein")
  })
})
