import { describe, expect, test } from "bun:test"
import type { CompatibilityDecision } from "../src/capability/compat"
import {
  evaluateJsonOutput,
  evaluateModality,
  evaluateReasoningReplay,
  evaluateSystemPlacement,
  evaluateToolChoice,
} from "../src/capability/compat"
import { CONSERVATIVE_PROFILE, narrowProfile, seedProfile, type CapabilityProfile } from "../src/capability/profile"

// Fixtures that DECLARE capabilities use seedProfile; narrowProfile can only
// narrow and is the wrong constructor for a supported-endpoint fixture.
const vision: CapabilityProfile = seedProfile({ family: "vision-test", input: { image: true } })
const tools: CapabilityProfile = seedProfile({
  family: "tools-test",
  tools: { tools: true, parallelTools: true, strictSchema: true, forcedChoice: true },
  json: "schema",
})

function actions(decisions: CompatibilityDecision[]) {
  return decisions.map((decision) => decision.action)
}

describe("evaluateModality", () => {
  test("unsupported image fails in strict mode", () => {
    expect(actions(evaluateModality("image", CONSERVATIVE_PROFILE, "strict"))).toEqual(["fail"])
  })

  test("unsupported image also fails in warn mode — silent discard is never allowed", () => {
    expect(actions(evaluateModality("image", CONSERVATIVE_PROFILE, "warn"))).toEqual(["fail"])
  })

  test("unsupported document converts to extracted text in bestEffort mode", () => {
    const decisions = evaluateModality("document", CONSERVATIVE_PROFILE, "bestEffort")
    expect(actions(decisions)).toEqual(["convert"])
    expect(decisions[0].reason).toContain("extract")
  })

  test("unsupported audio converts in bestEffort only when user enabled transcription", () => {
    expect(actions(evaluateModality("audio", CONSERVATIVE_PROFILE, "bestEffort", { transcriptionEnabled: false }))).toEqual(["fail"])
    expect(actions(evaluateModality("audio", CONSERVATIVE_PROFILE, "bestEffort", { transcriptionEnabled: true }))).toEqual(["convert"])
  })

  test("supported image produces no decisions", () => {
    expect(evaluateModality("image", vision, "strict")).toEqual([])
  })
})

describe("evaluateToolChoice", () => {
  test("required tool choice without tool support fails even in bestEffort", () => {
    expect(actions(evaluateToolChoice("required", CONSERVATIVE_PROFILE, "bestEffort"))).toEqual(["fail"])
  })

  test("supported tools produce no decisions", () => {
    expect(evaluateToolChoice("required", tools, "strict")).toEqual([])
  })
})

describe("evaluateJsonOutput", () => {
  test("native schema support produces no decisions", () => {
    expect(evaluateJsonOutput(tools, "strict")).toEqual([])
  })

  test("forced-tool fallback records a convert decision", () => {
    const forcedOnly = seedProfile({ family: "forced-only-test", tools: { tools: true, forcedChoice: true } })
    const decisions = evaluateJsonOutput(forcedOnly, "warn")
    expect(actions(decisions)).toEqual(["convert"])
    expect(decisions[0].reason).toContain("forced tool")
  })

  test("no schema output and no forced tool fails in strict", () => {
    expect(actions(evaluateJsonOutput(CONSERVATIVE_PROFILE, "strict"))).toEqual(["fail"])
  })

  test("no schema output and no forced tool falls back to prompt-and-validate in bestEffort with annotate", () => {
    expect(actions(evaluateJsonOutput(CONSERVATIVE_PROFILE, "bestEffort"))).toEqual(["annotate"])
  })
})

describe("evaluateReasoningReplay", () => {
  const provenance = { provider: "anthropic", endpointFamily: "anthropic-messages", model: "claude-opus-4-8", protocolVersion: "2025-11-01" }

  test("same-family replay produces no decisions", () => {
    const anthropic = narrowProfile(CONSERVATIVE_PROFILE, { family: "anthropic-messages" })
    expect(evaluateReasoningReplay(provenance, anthropic, "strict")).toEqual([])
  })

  test("cross-family replay always fails", () => {
    const openai = narrowProfile(CONSERVATIVE_PROFILE, { family: "openai-responses" })
    for (const mode of ["strict", "warn", "bestEffort"] as const) {
      expect(actions(evaluateReasoningReplay(provenance, openai, mode))).toEqual(["fail"])
    }
  })
})

describe("evaluateSystemPlacement", () => {
  test("untrusted content in the system channel always fails", () => {
    for (const mode of ["strict", "warn", "bestEffort"] as const) {
      expect(actions(evaluateSystemPlacement("untrusted", mode))).toEqual(["fail"])
    }
  })

  test("privileged content in the system channel produces no decisions", () => {
    expect(evaluateSystemPlacement("privileged", "strict")).toEqual([])
  })
})
