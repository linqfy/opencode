import { describe, expect, test } from "bun:test"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Auth } from "@opencode-ai/llm/route"
import { CONSERVATIVE_PROFILE } from "@ultracode/schema/capability"
import { Profile } from "@opencode-ai/core/capability/profile"

const openaiModel = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.com/v1" }, auth: Auth.bearer("fixture") })
  .model({ id: "gpt-4o-mini" })
const anthropicModel = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.com" }, auth: Auth.header("x-api-key", "fixture") })
  .model({ id: "claude-3-5-sonnet" })

describe("Profile.resolve", () => {
  test("seeds the profile from the route family and default limits", () => {
    const model = OpenAIChat.route
      .with({
        endpoint: { baseURL: "https://api.openai.com/v1" },
        auth: Auth.bearer("fixture"),
        limits: { context: 128_000, output: 16_000 },
      })
      .model({ id: "gpt-4o" })
    const { profile, known } = Profile.resolve(model)
    expect(known).toBe(true)
    expect(profile.family).toBe("openai-chat")
    expect(profile.contextTokens).toBe(128_000)
    expect(profile.outputTokens).toBe(16_000)
    expect(profile.caching.mode).toBe("auto")
  })

  test("a long-running session class opts into a 1h cache ttl", () => {
    const model = AnthropicMessages.route
      .with({
        endpoint: { baseURL: "https://api.anthropic.com" },
        auth: Auth.header("x-api-key", "fixture"),
        limits: { context: 200_000, output: 64_000 },
      })
      .model({ id: "claude-3-5-sonnet" })
    const { profile } = Profile.resolve(model, { ttlSeconds: 3600 })
    expect(profile.caching.ttlSeconds).toBe(3600)
  })

  test("an unknown route without capability defaults falls back to the conservative profile and is not known", () => {
    const bare = OpenAIChat.route
      .with({ endpoint: { baseURL: "https://api.openai.com/v1" }, auth: Auth.none })
      .model({ id: "mystery" })
    const { profile, known } = Profile.resolve(bare)
    expect(known).toBe(false)
    expect(profile).toEqual(CONSERVATIVE_PROFILE)
  })

  test("profileId is deterministic and distinct per (route, model)", () => {
    expect(Profile.profileId(openaiModel)).toBe(Profile.profileId(openaiModel))
    expect(Profile.profileId(openaiModel)).not.toBe(Profile.profileId(anthropicModel))
    expect(Profile.profileId(openaiModel)).toBe(`openai-chat:${openaiModel.provider}/${openaiModel.id}`)
  })
})
