export * as Profile from "./profile"

import { type Model } from "@opencode-ai/llm"
import { CONSERVATIVE_PROFILE, resolveProfile, type CapabilityProfile, type ProfileLayer } from "@ultracode/schema/capability"

export interface ResolvedProfile {
  readonly profile: CapabilityProfile
  readonly profileId: string
  readonly layers: readonly ProfileLayer[]
  readonly known: boolean
}

export const profileId = (model: Model) => `${model.route.id}:${model.provider}/${model.id}`

export const buildLayers = (model: Model, options: { readonly ttlSeconds?: number } = {}): readonly ProfileLayer[] => [
  {
    family: model.route.id,
    ...(model.route.defaults?.limits?.context === undefined
      ? {}
      : { contextTokens: model.route.defaults.limits.context }),
    ...(model.route.defaults?.limits?.output === undefined
      ? {}
      : { outputTokens: model.route.defaults.limits.output }),
  },
  {
    caching: {
      mode: "auto",
      breakpointLimit: 1,
      ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    },
  },
]

export const resolve = (model: Model, options: { readonly ttlSeconds?: number } = {}): ResolvedProfile => {
  const layers = buildLayers(model, options)
  const known = model.route.defaults?.limits?.context !== undefined
  if (!known) return { profile: CONSERVATIVE_PROFILE, profileId: profileId(model), layers, known }
  return { profile: resolveProfile(layers), profileId: profileId(model), layers, known }
}
