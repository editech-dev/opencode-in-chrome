import { describe, expect, test } from "bun:test"
import { MOD_BITS, keyPressEvent } from "../src/key-spec"

describe("keyPressEvent — CDP key events", () => {
  test("plain letter: text present, code Key* with correct VK", () => {
    const { down, up } = keyPressEvent("a")
    expect(down.type).toBe("keyDown")
    expect(down.code).toBe("KeyA")
    expect(down.windowsVirtualKeyCode).toBe(65)
    expect(down.text).toBe("a")
    expect(down.modifiers).toBe(0)
    expect(up.type).toBe("keyUp")
    expect(up.text).toBeUndefined()
  })

  test("shift+letter yields uppercase text and shift bit", () => {
    const { down } = keyPressEvent("shift+g")
    expect((down.modifiers & MOD_BITS.shift) !== 0).toBe(true)
    expect(down.text).toBe("G")
    expect(down.code).toBe("KeyG")
  })

  test("ctrl combo: no text, ctrl bit, VK ok", () => {
    const { down, up } = keyPressEvent("ctrl+a")
    expect(down.modifiers).toBe(MOD_BITS.ctrl)
    expect(down.text).toBeUndefined()
    expect(down.type).toBe("rawKeyDown")
    expect(up.windowsVirtualKeyCode).toBe(65)
  })

  test("named keys map to CDP codes and VKs", () => {
    expect(keyPressEvent("Enter").down).toMatchObject({ key: "Enter", windowsVirtualKeyCode: 13, text: "\r" })
    expect(keyPressEvent("ArrowDown").down).toMatchObject({ code: "ArrowDown", windowsVirtualKeyCode: 40 })
    expect(keyPressEvent("Escape").down).toMatchObject({ code: "Escape", windowsVirtualKeyCode: 27 })
    expect(keyPressEvent("Tab").down).toMatchObject({ code: "Tab", windowsVirtualKeyCode: 9 })
  })

  test("the literal + key parses", () => {
    const { down } = keyPressEvent("+")
    expect(down.code).toBe("Equal")
    expect(down.text).toBe("+")
  })

  test("unsupported multi-char keys are typed errors, not crashes", () => {
    expect(() => keyPressEvent("f5")).toThrow("unsupported key")
  })
})
