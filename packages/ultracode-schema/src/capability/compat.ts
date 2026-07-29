import { Schema } from "effect"
import type { CapabilityProfile } from "./profile"

// One compatibility decision per degraded or rejected input (spec section 6
// "Graceful degradation"). Mode policy: "strict" fails before the request if
// required semantics cannot be preserved; "warn" allows ONLY safe degradation
// with user visibility; "bestEffort" additionally permits configured local
// preprocessing with provenance. Nothing on the never-silently list (below)
// may degrade in any mode.

export const CompatibilityDecision = Schema.Struct({
  action: Schema.Literals(["fail", "convert", "strip", "annotate"]),
  target: Schema.String,
  reason: Schema.String,
  provenance: Schema.optional(Schema.String),
})
export type CompatibilityDecision = typeof CompatibilityDecision.Type

export type CompatibilityMode = "strict" | "warn" | "bestEffort"

function decision(action: CompatibilityDecision["action"], target: string, reason: string, provenance?: string): CompatibilityDecision {
  return provenance === undefined ? { action, target, reason } : { action, target, reason, provenance }
}

type Modality = "image" | "audio" | "video" | "document" | "text"

export function evaluateModality(
  modality: Modality,
  profile: CapabilityProfile,
  mode: CompatibilityMode,
  options?: { transcriptionEnabled?: boolean },
): CompatibilityDecision[] {
  if (profile.input[modality]) return []
  switch (modality) {
    case "text":
      return [decision("fail", modality, "endpoint accepts no text input")]
    case "image":
    case "video":
      // Never silently discard image/video content (spec never-silently list).
      return [decision("fail", modality, "endpoint does not support this modality; discarding media is never allowed")]
    case "document":
      if (mode === "bestEffort") {
        return [decision("convert", modality, "convert document to locally extracted, page-labeled text", "ultracode-conversion")]
      }
      return [decision("fail", modality, "endpoint does not support documents; enable bestEffort local extraction")]
    case "audio":
      if (mode === "bestEffort" && options?.transcriptionEnabled) {
        return [decision("convert", modality, "transcribe audio locally (user-enabled)", "ultracode-transcription")]
      }
      return [decision("fail", modality, "endpoint does not support audio and local transcription is not enabled")]
  }
}

export function evaluateToolChoice(
  choice: "auto" | "none" | "required" | "named",
  profile: CapabilityProfile,
  _mode: CompatibilityMode,
): CompatibilityDecision[] {
  if (profile.tools.tools) return []
  if (choice === "none" || choice === "auto") return []
  // Never weaken required tool choice (spec never-silently list).
  return [decision("fail", "toolChoice", "endpoint has no tool support; required/named tool choice cannot be weakened")]
}

export function evaluateJsonOutput(profile: CapabilityProfile, mode: CompatibilityMode): CompatibilityDecision[] {
  if (profile.json === "schema" || profile.json === "object") return []
  if (profile.tools.tools && profile.tools.forcedChoice) {
    return [decision("convert", "responseFormat", "lower JSON schema output to a forced tool call", "ultracode-json-fallback")]
  }
  if (mode === "bestEffort") {
    // Prompt-and-validate must never claim structured-output guarantees.
    return [decision("annotate", "responseFormat", "no native or forced-tool JSON mode; using prompt-and-validate without guarantees", "ultracode-json-prompt")]
  }
  return [decision("fail", "responseFormat", "endpoint cannot guarantee JSON output; enable bestEffort prompt-and-validate")]
}

// Family compatibility: opaque reasoning may only replay to the same family.
export function evaluateReasoningReplay(
  provenance: { provider: string; endpointFamily: string; model: string; protocolVersion: string },
  profile: CapabilityProfile,
  _mode: CompatibilityMode,
): CompatibilityDecision[] {
  if (provenance.endpointFamily === profile.family) return []
  return [
    decision(
      "fail",
      "reasoning",
      `opaque reasoning from ${provenance.endpointFamily} must not be replayed to ${profile.family}`,
    ),
  ]
}

// Privileged-channel contamination is always rejected (spec never-silently list).
export function evaluateSystemPlacement(trust: "privileged" | "untrusted", _mode: CompatibilityMode): CompatibilityDecision[] {
  if (trust === "privileged") return []
  return [decision("fail", "system-channel", "untrusted content must not be placed into a privileged instruction channel")]
}
