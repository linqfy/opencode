import { describe, expect, test } from "bun:test"
import { CONSERVATIVE_PROFILE, narrowProfile, resolveProfile, type CapabilityProfile } from "../src/capability/profile"

const anthropicBase: CapabilityProfile = {
  ...CONSERVATIVE_PROFILE,
  family: "anthropic-messages",
  contextTokens: 200_000,
  outputTokens: 64_000,
  caching: { mode: "ephemeral", breakpointLimit: 3, ttlSeconds: 3600 },
}

describe("capability profile contract (locked for runtime consumption)", () => {
  test("unknown and empty layers resolve to the conservative profile", () => {
    expect(resolveProfile([])).toEqual(CONSERVATIVE_PROFILE)
    expect(resolveProfile([{ input: { image: true } }])).toEqual(CONSERVATIVE_PROFILE)
  })

  test("caching strictness order none < auto < ephemeral < persistent: later layers only narrow", () => {
    expect(narrowProfile(anthropicBase, { caching: { mode: "auto" } }).caching.mode).toBe("auto")
    expect(narrowProfile(anthropicBase, { caching: { mode: "persistent" } }).caching.mode).toBe("ephemeral")
  })

  test("breakpointLimit and ttlSeconds take the minimum across layers", () => {
    const narrowed = narrowProfile(anthropicBase, { caching: { breakpointLimit: 1, ttlSeconds: 300 } })
    expect(narrowed.caching.breakpointLimit).toBe(1)
    expect(narrowed.caching.ttlSeconds).toBe(300)
  })

  test("a caching layer declares mode and ttl onto the undecorated conservative base", () => {
    const declared = narrowProfile(CONSERVATIVE_PROFILE, { caching: { mode: "auto", breakpointLimit: 1, ttlSeconds: 3600 } })
    expect(declared.caching.mode).toBe("auto")
    expect(declared.caching.breakpointLimit).toBe(1)
    expect(declared.caching.ttlSeconds).toBe(3600)
  })

  test("tools.hosted is not narrowed by later layers", () => {
    const base = { ...anthropicBase, tools: { ...anthropicBase.tools, tools: true, hosted: ["web_search"] } }
    expect(narrowProfile(base, { tools: { hosted: [] } }).tools.hosted).toEqual(["web_search"])
  })

  test("a conservative profile carries no caching and no stateful continuation", () => {
    expect(CONSERVATIVE_PROFILE.caching.mode).toBe("none")
    expect(CONSERVATIVE_PROFILE.continuation.stateful).toBe(false)
  })
})
