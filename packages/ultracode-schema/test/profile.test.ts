import { describe, expect, test } from "bun:test"
import {
  CapabilityProfile,
  CONSERVATIVE_PROFILE,
  narrowProfile,
  resolveProfile,
} from "../src/capability/profile"

describe("CapabilityProfile", () => {
  test("conservative profile is text-only with no enhancements", () => {
    expect(CONSERVATIVE_PROFILE.input.image).toBe(false)
    expect(CONSERVATIVE_PROFILE.tools.tools).toBe(false)
    expect(CONSERVATIVE_PROFILE.json).toBe("none")
    expect(CONSERVATIVE_PROFILE.caching.mode).toBe("none")
    expect(CONSERVATIVE_PROFILE.continuation.stateful).toBe(false)
  })
})

describe("narrowProfile", () => {
  const base: CapabilityProfile = {
    ...CONSERVATIVE_PROFILE,
    family: "anthropic-messages",
    input: { ...CONSERVATIVE_PROFILE.input, image: true, document: true },
    tools: { tools: true, parallelTools: true, strictSchema: true, forcedChoice: true, hosted: [] },
    contextTokens: 200_000,
    outputTokens: 64_000,
  }

  test("booleans only narrow downward", () => {
    const narrowed = narrowProfile(base, { input: { image: false } })
    expect(narrowed.input.image).toBe(false)
    expect(narrowed.input.document).toBe(true)
  })

  test("a later layer cannot widen capabilities", () => {
    const narrowed = narrowProfile(base, { input: { video: true } })
    expect(narrowed.input.video).toBe(false)
  })

  test("numeric limits take the minimum", () => {
    const narrowed = narrowProfile(base, { contextTokens: 128_000 })
    expect(narrowed.contextTokens).toBe(128_000)
    const kept = narrowProfile(base, { contextTokens: 400_000 })
    expect(kept.contextTokens).toBe(200_000)
  })
})

describe("resolveProfile", () => {
  test("the first layer seeds the base when it is an adapter declaration (family set)", () => {
    const resolved = resolveProfile([{ family: "openai-chat", input: { image: true }, json: "schema" }])
    expect(resolved.family).toBe("openai-chat")
    expect(resolved.input.image).toBe(true)
    expect(resolved.json).toBe("schema")
    expect(resolved.input.video).toBe(false)
  })

  test("layers after the adapter declaration narrow it in endpoint → catalog → overrides → discovery order", () => {
    const resolved = resolveProfile([
      { family: "openai-chat", input: { image: true }, json: "schema" },
      { json: "object" },
      { input: { image: false } },
      {},
      { input: { image: true } },
    ])
    expect(resolved.input.image).toBe(false)
    expect(resolved.json).toBe("object")
    expect(resolved.family).toBe("openai-chat")
  })

  test("empty layers yield the conservative profile", () => {
    const resolved = resolveProfile([])
    expect(resolved).toEqual(CONSERVATIVE_PROFILE)
  })
})
