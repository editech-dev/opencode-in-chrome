/**
 * Secret redaction for tool results (specs/05 invariant I3).
 *
 * Line-based and deterministic on purpose: every line with a separator (`:` or
 * `=`) whose KEY looks sensitive is rewritten to `key: [REDACTED]`, keeping the
 * key visible for the model. A second pass handles JSON-shaped pairs inline.
 * Over-redacting a click coordinate is harmless; leaking a password is not.
 */

const REDACTED = "[REDACTED]"

/** Whole-token key check (used per line, case-insensitive). */
const KEY_TOKEN =
  /(?:^|[._\-\s])(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|auth(?:orization(?:[._-]token)?)?|bearer|credentials?|session[_-]?id|cookie)(?:$|[._\-\s])/i

function redactLine(line: string): string {
  const sep = /[:=]/.exec(line)
  if (!sep) return line
  const key = line.slice(0, sep.index).trim()
  if (!key || !KEY_TOKEN.test(key)) return line
  const rest = line.slice(sep.index + 1)
  if (!rest.trim()) return line // separator without a value: nothing to leak
  const indent = /^(?:\s*[-*]?\s*)/.exec(line)?.[0] ?? ""
  return `${indent}${key}: ${REDACTED}`
}

/** Redacts `key: value` / `key = value` pairs whose key looks sensitive. */
export function redactSecrets(text: string): string {
  if (!text) return text
  return text.split("\n").map(redactLine).join("\n")
}

const JSON_PAIR =
  /("(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|auth(?:orization(?:[._-]token)?)?|bearer|credentials?|session[_-]?id|cookie)[\w.\-_]*"\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi

/** Redacts JSON-shaped `"key": "value"` pairs whose key looks sensitive. */
export function redactJsonSecrets(text: string): string {
  if (!text) return text
  return text.replace(JSON_PAIR, `$1"${REDACTED.slice(1, -1)}"`)
}

/** Convenience: apply both passes. */
export function redactAll(text: string): string {
  return redactSecrets(redactJsonSecrets(text))
}
