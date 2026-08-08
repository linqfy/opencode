import type { CapabilityProfile } from "./profile"

export interface CachePolicySpec {
  readonly tools?: boolean
  readonly system?: boolean
  readonly messages?: "latest-user-message" | "latest-assistant" | { readonly tail: number }
  readonly ttlSeconds?: number
}

const AUTO_PLACEMENT = { tools: true, system: true, messages: "latest-user-message" } as const

export function profileCachePolicy(profile: CapabilityProfile): CachePolicySpec {
  if (profile.caching.mode === "none") return {}
  return {
    ...AUTO_PLACEMENT,
    ...(profile.caching.ttlSeconds === undefined ? {} : { ttlSeconds: profile.caching.ttlSeconds }),
  }
}
