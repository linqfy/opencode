import { Schema } from "effect"

// Capability profile per endpoint + exact model (spec section 6).
// Unknown compatible endpoints resolve to CONSERVATIVE_PROFILE: implementing
// /chat/completions implies nothing beyond plain text.

export const Modalities = Schema.Struct({
  text: Schema.Boolean,
  image: Schema.Boolean,
  audio: Schema.Boolean,
  video: Schema.Boolean,
  document: Schema.Boolean,
  mimes: Schema.optional(Schema.Array(Schema.String)),
})
export type Modalities = typeof Modalities.Type

export const MediaLimits = Schema.Struct({
  maxBytesPerItem: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  maxItemsPerRequest: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  maxImagePixels: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
})
export type MediaLimits = typeof MediaLimits.Type

export const ToolCaps = Schema.Struct({
  tools: Schema.Boolean,
  parallelTools: Schema.Boolean,
  strictSchema: Schema.Boolean,
  forcedChoice: Schema.Boolean,
  hosted: Schema.Array(Schema.String),
})
export type ToolCaps = typeof ToolCaps.Type

export const ReasoningCaps = Schema.Struct({
  effort: Schema.Boolean,
  summary: Schema.Boolean,
  opaqueReplay: Schema.Boolean,
})
export type ReasoningCaps = typeof ReasoningCaps.Type

export const CachingCaps = Schema.Struct({
  mode: Schema.Literals(["none", "auto", "ephemeral", "persistent"]),
  ttlSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  breakpointLimit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type CachingCaps = typeof CachingCaps.Type

export const CapabilityProfile = Schema.Struct({
  family: Schema.String,
  endpointURL: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  input: Modalities,
  output: Modalities,
  media: MediaLimits,
  contextTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  outputTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  tools: ToolCaps,
  json: Schema.Literals(["none", "object", "schema"]),
  reasoning: ReasoningCaps,
  systemRole: Schema.Literals(["system", "developer", "none"]),
  continuation: Schema.Struct({ stateful: Schema.Boolean }),
  caching: CachingCaps,
  streaming: Schema.Struct({ events: Schema.Boolean, framing: Schema.Literals(["sse", "jsonl", "none"]) }),
  accounting: Schema.Struct({ usage: Schema.Boolean, cachedTokens: Schema.Boolean, reasoningTokens: Schema.Boolean }),
  retention: Schema.Struct({ zeroRetention: Schema.Boolean, region: Schema.optional(Schema.String) }),
  quirks: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "Ultra.CapabilityProfile" })
export type CapabilityProfile = typeof CapabilityProfile.Type

const textOnly: Modalities = { text: true, image: false, audio: false, video: false, document: false }

export const CONSERVATIVE_PROFILE: CapabilityProfile = {
  family: "generic",
  input: textOnly,
  output: { ...textOnly },
  media: {},
  contextTokens: 8192,
  outputTokens: 4096,
  tools: { tools: false, parallelTools: false, strictSchema: false, forcedChoice: false, hosted: [] },
  json: "none",
  reasoning: { effort: false, summary: false, opaqueReplay: false },
  systemRole: "system",
  continuation: { stateful: false },
  caching: { mode: "none", breakpointLimit: 0 },
  streaming: { events: false, framing: "sse" },
  accounting: { usage: true, cachedTokens: false, reasoningTokens: false },
  retention: { zeroRetention: false },
  quirks: {},
}

// Recursive "narrow only" merge: booleans AND, numbers take the minimum,
// arrays intersect, json/systemRole/caching.mode take the stricter value,
// everything else from the base. A layer can never widen the base.
export type ProfileLayer = { [key: string]: unknown }

// Effect Schema .Type fields are readonly; mutation needs a deep-mutable view.
type DeepMutable<T> = { -readonly [K in keyof T]: T[K] extends object ? DeepMutable<T[K]> : T[K] }

const JSON_STRICTNESS = ["none", "object", "schema"] as const
const CACHE_STRICTNESS = ["none", "auto", "ephemeral", "persistent"] as const
const ROLE_STRICTNESS = ["none", "developer", "system"] as const

function stricter(a: string, b: string, order: readonly string[]) {
  return order[Math.min(order.indexOf(a), order.indexOf(b))] ?? a
}

export function narrowProfile(base: CapabilityProfile, layer: ProfileLayer): CapabilityProfile {
  const out = {
    ...base,
    input: { ...base.input },
    output: { ...base.output },
    media: { ...base.media },
    tools: { ...base.tools, hosted: base.tools.hosted },
    reasoning: { ...base.reasoning },
    caching: { ...base.caching },
    continuation: { ...base.continuation },
    streaming: { ...base.streaming },
    accounting: { ...base.accounting },
    retention: { ...base.retention },
    quirks: { ...base.quirks },
  } as DeepMutable<CapabilityProfile>
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined || value === null) continue
    switch (key) {
      case "family":
        out.family = String(value)
        break
      case "endpointURL":
        out.endpointURL = String(value)
        break
      case "modelID":
        out.modelID = String(value)
        break
      case "contextTokens":
        out.contextTokens = Math.min(out.contextTokens, Number(value))
        break
      case "outputTokens":
        out.outputTokens = Math.min(out.outputTokens, Number(value))
        break
      case "json":
        out.json = stricter(out.json, String(value), JSON_STRICTNESS) as typeof out.json
        break
      case "systemRole":
        out.systemRole = stricter(out.systemRole, String(value), ROLE_STRICTNESS) as typeof out.systemRole
        break
      case "input":
      case "output":
        for (const [field, fieldValue] of Object.entries(value as ProfileLayer)) {
          const k = field as keyof Modalities
          if (k === "mimes") continue
          const current = out[key][k]
          if (typeof current === "boolean") (out[key] as Record<string, unknown>)[k] = current && Boolean(fieldValue)
        }
        break
      case "media":
        for (const [field, fieldValue] of Object.entries(value as ProfileLayer)) {
          const k = field as keyof MediaLimits
          const current = out.media[k]
          if (current === undefined) continue
          if (typeof current === "number") (out.media as Record<string, unknown>)[k] = Math.min(current, Number(fieldValue))
        }
        break
      case "tools":
        for (const [field, fieldValue] of Object.entries(value as ProfileLayer)) {
          if (field === "hosted") continue
          const k = field as keyof ToolCaps
          const current = out.tools[k]
          if (typeof current === "boolean") (out.tools as Record<string, unknown>)[k] = current && Boolean(fieldValue)
        }
        break
      case "reasoning":
        for (const [field, fieldValue] of Object.entries(value as ProfileLayer)) {
          const k = field as keyof ReasoningCaps
          const current = out.reasoning[k]
          if (typeof current === "boolean") (out.reasoning as Record<string, unknown>)[k] = current && Boolean(fieldValue)
        }
        break
      case "caching": {
        const layerCache = value as ProfileLayer
        if (layerCache.mode) out.caching.mode = stricter(out.caching.mode, String(layerCache.mode), CACHE_STRICTNESS) as typeof out.caching.mode
        if (layerCache.ttlSeconds !== undefined && out.caching.ttlSeconds !== undefined) out.caching.ttlSeconds = Math.min(out.caching.ttlSeconds, Number(layerCache.ttlSeconds))
        if (layerCache.breakpointLimit !== undefined) out.caching.breakpointLimit = Math.min(out.caching.breakpointLimit, Number(layerCache.breakpointLimit))
        break
      }
      case "quirks":
        out.quirks = { ...out.quirks, ...(value as Record<string, unknown>) }
        break
      default:
        break
    }
  }
  return out
}

// The adapter declaration seeds the base profile: it DECLARES the ceiling,
// so booleans/numbers apply directly instead of narrowing. Everything after
// the seed narrows only.
export function seedProfile(layer: ProfileLayer): CapabilityProfile {
  const seeded = JSON.parse(JSON.stringify(CONSERVATIVE_PROFILE)) as CapabilityProfile
  const apply = (target: Record<string, unknown>, layerObj: ProfileLayer, path: (string | number)[]) => {
    for (const [key, value] of Object.entries(layerObj)) {
      if (value === undefined || value === null) continue
      if (typeof value === "object" && !Array.isArray(value) && typeof target[key] === "object" && target[key] !== null) {
        apply(target[key] as Record<string, unknown>, value as ProfileLayer, [...path, key])
        continue
      }
      if (Array.isArray(value) && Array.isArray(target[key])) {
        target[key] = value
        continue
      }
      target[key] = value
    }
  }
  apply(seeded as unknown as Record<string, unknown>, layer, [])
  return seeded
}

// Resolution order (spec section 6): adapter declaration, configured endpoint
// profile, model catalog metadata, administrator/user overrides, safe runtime
// discovery. The adapter layer declares the ceiling; every later layer narrows.
export function resolveProfile(layers: ProfileLayer[]): CapabilityProfile {
  if (layers.length === 0) return CONSERVATIVE_PROFILE
  let profile = typeof layers[0].family === "string" ? seedProfile(layers[0]) : CONSERVATIVE_PROFILE
  const rest = typeof layers[0].family === "string" ? layers.slice(1) : layers
  for (const layer of rest) {
    profile = narrowProfile(profile, layer)
  }
  return profile
}
