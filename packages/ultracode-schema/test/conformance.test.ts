import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { join } from "node:path"
import {
  evaluateJsonOutput,
  evaluateModality,
  evaluateReasoningReplay,
  evaluateSystemPlacement,
  evaluateToolChoice,
  type CompatibilityDecision,
  type CompatibilityMode,
} from "../src/capability/compat"
import { CapabilityProfile } from "../src/capability/profile"

const dir = join(import.meta.dir, "fixtures", "profiles")
const ProfileJson = Schema.fromJsonString(CapabilityProfile)

async function loadProfile(name: string): Promise<CapabilityProfile> {
  return Schema.decodeUnknownSync(ProfileJson)(await Bun.file(join(dir, `${name}.json`)).text())
}

const profiles = {
  "anthropic-messages": await loadProfile("anthropic-messages"),
  "openai-chat": await loadProfile("openai-chat"),
  "openai-responses": await loadProfile("openai-responses"),
  "openai-compatible-generic": await loadProfile("openai-compatible-generic"),
  "anthropic-compatible-generic": await loadProfile("anthropic-compatible-generic"),
}
type ProfileName = keyof typeof profiles

type Scenario = {
  name: string
  run: (profile: CapabilityProfile, mode: CompatibilityMode) => CompatibilityDecision[]
  expect: (decisions: CompatibilityDecision[]) => string[]
}

function actions(decisions: CompatibilityDecision[]) {
  return decisions.map((decision) => decision.action)
}

const anthropicReasoning = { provider: "anthropic", endpointFamily: "anthropic-messages", model: "claude-opus-4-8", protocolVersion: "2025-11-01" }

const scenarios: { name: string; scenario: Scenario["run"]; modes: CompatibilityMode[]; expected: Record<ProfileName, CompatibilityDecision["action"][]> }[] = [
  {
    name: "image input",
    scenario: (profile, mode) => evaluateModality("image", profile, mode),
    modes: ["strict"],
    expected: {
      "anthropic-messages": [],
      "openai-chat": [],
      "openai-responses": [],
      "openai-compatible-generic": ["fail"],
      "anthropic-compatible-generic": ["fail"],
    },
  },
  {
    name: "document input in bestEffort",
    scenario: (profile, mode) => evaluateModality("document", profile, mode),
    modes: ["bestEffort"],
    expected: {
      "anthropic-messages": [],
      "openai-chat": ["convert"],
      "openai-responses": [],
      "openai-compatible-generic": ["convert"],
      "anthropic-compatible-generic": ["convert"],
    },
  },
  {
    name: "audio input without transcription in bestEffort",
    scenario: (profile, mode) => evaluateModality("audio", profile, mode, { transcriptionEnabled: false }),
    modes: ["bestEffort"],
    expected: {
      "anthropic-messages": ["fail"],
      "openai-chat": [],
      "openai-responses": [],
      "openai-compatible-generic": ["fail"],
      "anthropic-compatible-generic": ["fail"],
    },
  },
  {
    name: "required tool choice",
    scenario: (profile, mode) => evaluateToolChoice("required", profile, mode),
    modes: ["bestEffort"],
    expected: {
      "anthropic-messages": [],
      "openai-chat": [],
      "openai-responses": [],
      "openai-compatible-generic": ["fail"],
      "anthropic-compatible-generic": ["fail"],
    },
  },
  {
    name: "JSON schema output in warn mode",
    scenario: (profile, mode) => evaluateJsonOutput(profile, mode),
    modes: ["warn"],
    expected: {
      "anthropic-messages": [],
      "openai-chat": [],
      "openai-responses": [],
      "openai-compatible-generic": ["fail"],
      "anthropic-compatible-generic": ["fail"],
    },
  },
  {
    name: "anthropic opaque reasoning replayed to openai-responses",
    scenario: (profile, mode) => evaluateReasoningReplay(anthropicReasoning, profile, mode),
    modes: ["strict", "warn", "bestEffort"],
    expected: {
      "anthropic-messages": [],
      "openai-chat": ["fail"],
      "openai-responses": ["fail"],
      "openai-compatible-generic": ["fail"],
      "anthropic-compatible-generic": ["fail"],
    },
  },
  {
    name: "untrusted content into system channel",
    scenario: (_profile, mode) => evaluateSystemPlacement("untrusted", mode),
    modes: ["strict", "warn", "bestEffort"],
    expected: {
      "anthropic-messages": ["fail"],
      "openai-chat": ["fail"],
      "openai-responses": ["fail"],
      "openai-compatible-generic": ["fail"],
      "anthropic-compatible-generic": ["fail"],
    },
  },
]

for (const { name, scenario, modes, expected } of scenarios) {
  describe(`scenario: ${name}`, () => {
    for (const mode of modes) {
      for (const profileName of Object.keys(profiles) as ProfileName[]) {
        test(`${profileName} [${mode}]`, () => {
          expect(actions(scenario(profiles[profileName], mode))).toEqual(expected[profileName])
        })
      }
    }
  })
}

test("every fixture decodes through CapabilityProfile", () => {
  for (const profile of Object.values(profiles)) {
    expect(profile.contextTokens).toBeGreaterThan(0)
    expect(profile.input.text).toBe(true)
  }
})
