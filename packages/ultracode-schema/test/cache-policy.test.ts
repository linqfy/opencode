import { describe, expect, test } from "bun:test"
import { CONSERVATIVE_PROFILE, type CapabilityProfile } from "../src/capability/profile"
import { profileCachePolicy } from "../src/capability/cache"

const withCaching = (caching: CapabilityProfile["caching"]): CapabilityProfile => ({
  ...CONSERVATIVE_PROFILE,
  caching,
})

describe("profileCachePolicy", () => {
  test("a conservative profile (mode none) disables auto placement", () => {
    expect(profileCachePolicy(CONSERVATIVE_PROFILE)).toEqual({})
  })

  test("mode auto maps to tools + system + latest-user-message placement", () => {
    expect(profileCachePolicy(withCaching({ mode: "auto", breakpointLimit: 3 }))).toEqual({
      tools: true,
      system: true,
      messages: "latest-user-message",
    })
  })

  test("ephemeral with a ttl carries the ttl so the llm tier mapping can emit the 1h cache", () => {
    expect(profileCachePolicy(withCaching({ mode: "ephemeral", breakpointLimit: 3, ttlSeconds: 3600 }))).toEqual({
      tools: true,
      system: true,
      messages: "latest-user-message",
      ttlSeconds: 3600,
    })
  })

  test("persistent maps to auto placement plus the profile ttl", () => {
    expect(profileCachePolicy(withCaching({ mode: "persistent", breakpointLimit: 5, ttlSeconds: 3600 }))).toEqual({
      tools: true,
      system: true,
      messages: "latest-user-message",
      ttlSeconds: 3600,
    })
  })

  test("ephemeral without a ttl omits ttlSeconds", () => {
    expect(profileCachePolicy(withCaching({ mode: "ephemeral", breakpointLimit: 3 }))).toEqual({
      tools: true,
      system: true,
      messages: "latest-user-message",
    })
  })
})
