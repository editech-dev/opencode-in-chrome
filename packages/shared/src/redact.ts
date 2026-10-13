/**
 * Secret redaction for tool results (specs/05 invariant #3).
 *
 * Anything a model could echo back into a page, a log or a remote MCP client must
 * pass through here. Deliberately conservative: over-redacting a click coordinate
 * is harmless; leaking a password is not.
 */

const SENSITIVE_KEY =
  /(\b(pass(word|wd)?|pwd|secret|token|api[_-]?key|apikey|auth(orization)?|bearer|credential(s)?|session[_-]?id|cookie)s?\b)/i

const KEY_VALUE_LINE = new RegExp(
  `([\\r\\n\\t ]*|^)(${SENSITIVE_KEY.source.slice(2, -1)})[\\t ]*[:=][\\t ]*["']?([^"'\\n\\r\\t]{1,4096}?)["']?([\\r\\n,;]|$)`,
  "gi",
)

const REDACTED = "[REDACTED]"

/** Redacts `key: value` / `key=value` pairs whose key looks sensitive. */
export function redactSecrets(text: string): string {
  if (!text) return text
  return text.replace(
    KEY_VALUE_LINE,
    (_m, lead: string, key: string, _value: string, tail: string) =>
      `${lead}${key}: ${REDACTED}${tail}`,
  )
}

const KEY_PATH_PAIR = new RegExp(`("${SENSITIVE_KEY.source.slice(2, -1)}")\\s*:\\s*("[^"\\\\\\n\\r]{1,4096}")`, "gi")

/** Redacts JSON-shaped `"key": "value"` pairs whose key looks sensitive. */
export function redactJsonSecrets(text: string): string {
  if (!text) return text
  return text.replace(KEY_PATH_PAIR, `$1: "${REDACTED}"`)
}

/** Convenience: apply both passes. */
export function redactAll(text: string): string {
  return redactSecrets(redactJsonSecrets(text))
}
