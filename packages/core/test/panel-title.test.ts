import { describe, expect, test } from "bun:test"
import { isDefaultPanelTitle, panelTitleFromPrompt } from "../src/panel-title"

describe("panelTitleFromPrompt", () => {
  test("strips the page-context prefix", () => {
    expect(panelTitleFromPrompt("[contexto: el usuario está viendo esta página — tabId 1: https://x] hola")).toBe(
      "Panel — hola",
    )
  })
  test("collapses whitespace and truncates", () => {
    const long = "a".repeat(80)
    const title = panelTitleFromPrompt(long, 20)
    expect(title.startsWith("Panel — ")).toBe(true)
    expect(title.length).toBeLessThanOrEqual("Panel — ".length + 20)
    expect(title.endsWith("…")).toBe(true)
  })
  test("empty prompt falls back to Panel", () => {
    expect(panelTitleFromPrompt("   ")).toBe("Panel")
  })
})

describe("isDefaultPanelTitle", () => {
  test("matches only the panel placeholders", () => {
    expect(isDefaultPanelTitle("Panel")).toBe(true)
    expect(isDefaultPanelTitle("Panel 10:30")).toBe(true)
    expect(isDefaultPanelTitle("Panel — topic")).toBe(false)
    expect(isDefaultPanelTitle("fix: something")).toBe(false)
  })
})
