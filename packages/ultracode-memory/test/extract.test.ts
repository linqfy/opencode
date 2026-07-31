import { describe, expect, test } from "bun:test"
import { extractMemory, redactSecrets, type MemoryExtractor } from "../src/extract"

describe("redactSecrets", () => {
  test("redacts obvious secrets", () => {
    expect(redactSecrets("key=sk-abc123def456")).toContain("[REDACTED]")
    expect(redactSecrets("no secrets here")).toBe("no secrets here")
  })
})

describe("extractMemory", () => {
  test("parses the extractor's strict JSON output", async () => {
    const extractor: MemoryExtractor = async () =>
      JSON.stringify({ raw_memory: "raw mem", rollout_summary: "roll sum", rollout_slug: "slug" })
    const result = await extractMemory("transcript", extractor)
    expect(result?.rawMemory).toBe("raw mem")
    expect(result?.rolloutSummary).toBe("roll sum")
    expect(result?.rolloutSlug).toBe("slug")
  })

  test("redacts secrets in the extraction output", async () => {
    const extractor: MemoryExtractor = async () =>
      JSON.stringify({ raw_memory: "token sk-secretvalue123456", rollout_summary: "sum", rollout_slug: null })
    const result = await extractMemory("transcript", extractor)
    expect(result?.rawMemory).toContain("[REDACTED]")
  })

  test("fails closed (undefined) when the extractor throws", async () => {
    const extractor: MemoryExtractor = async () => {
      throw new Error("LLM down")
    }
    const result = await extractMemory("transcript", extractor)
    expect(result).toBeUndefined()
  })

  test("fails closed (undefined) on invalid JSON output", async () => {
    const extractor: MemoryExtractor = async () => "not json"
    const result = await extractMemory("transcript", extractor)
    expect(result).toBeUndefined()
  })
})
