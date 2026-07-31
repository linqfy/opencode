import { describe, expect, test } from "bun:test"
import {
  CONSOLIDATION_OUTPUT_SCHEMA,
  consolidateMemory,
  type MemoryConsolidator,
  type MemoryRecord,
} from "../src"

const record = (threadId: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  threadId,
  sourceUpdatedAt: 100,
  rawMemory: "memory",
  rolloutSummary: "summary",
  cwd: "/workspace",
  generatedAt: 100,
  usageCount: 0,
  ...overrides,
})

describe("consolidateMemory", () => {
  test("exports the strict consolidation output schema", () => {
    expect(CONSOLIDATION_OUTPUT_SCHEMA).toEqual({
      type: "object",
      properties: {
        summary: { type: "string" },
        memory: { type: "string" },
        source_thread_ids: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "memory", "source_thread_ids"],
      additionalProperties: false,
    })
  })

  test("passes records ranked for consolidation to the consolidator", async () => {
    const records = [
      record("low", { usageCount: 1, sourceUpdatedAt: 300 }),
      record("high", { usageCount: 2, sourceUpdatedAt: 100 }),
      record("empty", { rawMemory: "", rolloutSummary: "" }),
      record("recent", { usageCount: 1, sourceUpdatedAt: 400 }),
    ]
    let received: readonly MemoryRecord[] | undefined
    const consolidator: MemoryConsolidator = async (input) => {
      received = input
      return JSON.stringify({
        summary: "summary",
        memory: "memory",
        source_thread_ids: ["high"],
      })
    }

    await consolidateMemory(records, consolidator)

    expect(received?.map((item) => item.threadId)).toEqual(["high", "recent", "low"])
  })

  test("parses valid strict consolidation output", async () => {
    const consolidator: MemoryConsolidator = async () =>
      JSON.stringify({
        summary: "Combined summary",
        memory: "Combined memory",
        source_thread_ids: ["first", "second"],
      })

    const result = await consolidateMemory([record("first"), record("second")], consolidator)

    expect(result).toEqual({
      summary: "Combined summary",
      memory: "Combined memory",
      sourceThreadIds: ["first", "second"],
    })
  })

  test("redacts secrets from consolidation text", async () => {
    const consolidator: MemoryConsolidator = async () =>
      JSON.stringify({
        summary: "token sk-secretvalue123456",
        memory: "api_key=abcdefghijklmnop",
        source_thread_ids: ["first"],
      })

    const result = await consolidateMemory([record("first")], consolidator)

    expect(result?.summary).toContain("[REDACTED]")
    expect(result?.memory).toContain("[REDACTED]")
  })

  test("fails closed when the consolidator throws", async () => {
    const consolidator: MemoryConsolidator = async () => {
      throw new Error("LLM down")
    }

    expect(await consolidateMemory([record("first")], consolidator)).toBeUndefined()
  })

  test("fails closed on malformed consolidation JSON", async () => {
    const consolidator: MemoryConsolidator = async () => "not json"

    expect(await consolidateMemory([record("first")], consolidator)).toBeUndefined()
  })

  test("fails closed when consolidation fields have wrong types", async () => {
    const consolidator: MemoryConsolidator = async () =>
      JSON.stringify({ summary: "summary", memory: "memory", source_thread_ids: "first" })

    expect(await consolidateMemory([record("first")], consolidator)).toBeUndefined()
  })

  test("fails closed when summary and memory are empty", async () => {
    const consolidator: MemoryConsolidator = async () =>
      JSON.stringify({ summary: "", memory: "", source_thread_ids: ["first"] })

    expect(await consolidateMemory([record("first")], consolidator)).toBeUndefined()
  })

  test("fails closed when a source thread ID was not selected", async () => {
    const consolidator: MemoryConsolidator = async () =>
      JSON.stringify({ summary: "summary", memory: "memory", source_thread_ids: ["missing"] })

    expect(await consolidateMemory([record("first")], consolidator)).toBeUndefined()
  })

  test("deduplicates valid source thread IDs in first-seen order", async () => {
    const consolidator: MemoryConsolidator = async () =>
      JSON.stringify({
        summary: "summary",
        memory: "memory",
        source_thread_ids: ["second", "first", "second", "first"],
      })

    const result = await consolidateMemory([record("first"), record("second")], consolidator)

    expect(result?.sourceThreadIds).toEqual(["second", "first"])
  })

  test("does not mutate the input records or their array", async () => {
    const records = [
      record("first", { usageCount: 1, sourceUpdatedAt: 100 }),
      record("second", { usageCount: 2, sourceUpdatedAt: 200 }),
    ]
    const original = structuredClone(records)
    const consolidator: MemoryConsolidator = async () =>
      JSON.stringify({ summary: "summary", memory: "memory", source_thread_ids: ["second"] })

    await consolidateMemory(records, consolidator)

    expect(records).toEqual(original)
  })
})
