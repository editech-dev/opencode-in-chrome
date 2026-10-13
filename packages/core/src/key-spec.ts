/**
 * CDP `Input.dispatchKeyEvent` spec builder — pure, validated by tests.
 *
 * Parses agent-friendly key specs like "ctrl+shift+a", "Enter", "ArrowDown",
 * "Escape", a single character, or the literal "+" — and returns the CDP event
 * parameter objects (down/up) with correct virtual key codes and modifier bits.
 *
 * Mirrored in the extension service worker until the WXT bundler lands (T10).
 */

export type CdpKeyEvent = {
  type: "keyDown" | "rawKeyDown" | "keyUp"
  key: string
  code: string
  windowsVirtualKeyCode: number
  modifiers: number
  text?: string
}

export const MOD_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const

/** CDP virtual key codes for the named subset the agents realistically use. */
const NAMED: Record<string, { vk: number; key: string; code: string; text?: string }> = {
  Enter: { vk: 13, key: "Enter", code: "Enter", text: "\r" },
  Return: { vk: 13, key: "Enter", code: "Enter", text: "\r" },
  Tab: { vk: 9, key: "Tab", code: "Tab" },
  Escape: { vk: 27, key: "Escape", code: "Escape" },
  Esc: { vk: 27, key: "Escape", code: "Escape" },
  Backspace: { vk: 8, key: "Backspace", code: "Backspace" },
  Delete: { vk: 46, key: "Delete", code: "Delete" },
  Space: { vk: 32, key: " ", code: "Space", text: " " },
  PageUp: { vk: 33, key: "PageUp", code: "PageUp" },
  PageDown: { vk: 34, key: "PageDown", code: "PageDown" },
  End: { vk: 35, key: "End", code: "End" },
  Home: { vk: 36, key: "Home", code: "Home" },
  ArrowLeft: { vk: 37, key: "ArrowLeft", code: "ArrowLeft" },
  ArrowUp: { vk: 38, key: "ArrowUp", code: "ArrowUp" },
  ArrowRight: { vk: 39, key: "ArrowRight", code: "ArrowRight" },
  ArrowDown: { vk: 40, key: "ArrowDown", code: "ArrowDown" },
  Insert: { vk: 45, key: "Insert", code: "Insert" },
}

export type KeyPressEvent = { down: CdpKeyEvent; up: CdpKeyEvent }

/** Builds press/release CDP events for one key spec (e.g. "ctrl+shift+a"). */
export function keyPressEvent(spec: string): KeyPressEvent {
  const modifiers =
    (/ctrl/i.test(spec) ? MOD_BITS.ctrl : 0) |
    (/alt/i.test(spec) ? MOD_BITS.alt : 0) |
    (/meta|cmd/i.test(spec) ? MOD_BITS.meta : 0) |
    (/shift/i.test(spec) ? MOD_BITS.shift : 0)

  // The final token is the key itself ("ctrl+a" → "a", "Enter" → "Enter").
  const tokens = spec.split(/[+-]/).filter(Boolean)
  let key = tokens.at(-1) ?? spec
  if (key.length === 0) key = spec === "+" ? "+" : key

  let named = NAMED[key] ?? NAMED[key.toLowerCase()] ?? (key === "+" ? { vk: 187, key: "+", code: "Equal", text: "+" } : undefined)

  if (!named) {
    if (key.length === 1 && /[a-z0-9]/i.test(key)) {
      const upper = key.toUpperCase()
      named =
        upper >= "A" && upper <= "Z"
          ? { vk: upper.charCodeAt(0), key: upper.toLowerCase(), code: `Key${upper}`, text: modifiers & MOD_BITS.shift ? upper : key }
          : { vk: upper.charCodeAt(0), key: key, code: `Digit${key}`, text: key }
    } else {
      throw new Error(`computer: unsupported key "${spec}" — named keys or single chars only`)
    }
  }

  const base = {
    key: named.key,
    code: named.code,
    windowsVirtualKeyCode: named.vk,
    modifiers,
  }
  const text = modifiers & MOD_BITS.ctrl || modifiers & MOD_BITS.alt || modifiers & MOD_BITS.meta ? undefined : named.text
  return {
    down: { ...base, type: text ? "keyDown" : "rawKeyDown", ...(text ? { text } : {}) },
    up: { ...base, type: "keyUp" },
  }
}
