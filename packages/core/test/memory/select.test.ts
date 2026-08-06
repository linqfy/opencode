import { describe, expect, test } from "bun:test"
import type { MemoryRecord } from "@ultracode/memory"
import { MAX_MEMORY_BYTES_PER_RECORD, MAX_MEMORY_RECORDS, MAX_MEMORY_TOTAL_BYTES, TRUNCATION_MARKER, selectForInjection } from "@opencode-ai/core/memory/select"

const options = {
  maxRecords: MAX_MEMORY_RECORDS,
  maxBytesPerRecord: MAX_MEMORY_BYTES_PER_RECORD,
  maxTotalBytes: MAX_MEMORY_TOTAL_BYTES,
  now: 100_000,
}

const record = (threadId: string, over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  threadId,
  sourceUpdatedAt: 1000,
  rawMemory: "raw",
  rolloutSummary: "summary",
  cwd: "/repo",
  generatedAt: 1000,
  usageCount: 0,
  ...over,
})

const byteLength = (text: string): number => new TextEncoder().encode(text).length

describe("selectForInjection", () => {
  test("caps the record count at maxRecords and reports the rest as omitted", () => {
    const records = Array.from({ length: 8 }, (_, index) => record(`t${index}`, { sourceUpdatedAt: 1000 + index }))
    const result = selectForInjection(records, options)

    expect(result.records).toHaveLength(MAX_MEMORY_RECORDS)
    expect(result.omitted).toBe(3)
  })

  test("truncates a record whose text exceeds maxBytesPerRecord and appends the truncation marker", () => {
    const text = "a".repeat(2_000)
    const result = selectForInjection([record("big", { rawMemory: text, rolloutSummary: "" })], {
      ...options,
      maxBytesPerRecord: 100,
    })

    const capped = result.records[0]
    expect(capped).toBeDefined()
    if (!capped) return
    expect(capped.rawMemory).not.toBe(text)
    expect(capped.rawMemory.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(byteLength(capped.rawMemory)).toBeLessThanOrEqual(100)
  })

  test("drops the lowest-freshness records to respect the cumulative byte cap", () => {
    const records = [
      record("oldest", { sourceUpdatedAt: 100, rawMemory: "x".repeat(300) }),
      record("middle", { sourceUpdatedAt: 200, rawMemory: "x".repeat(300) }),
      record("newest", { sourceUpdatedAt: 300, rawMemory: "x".repeat(300) }),
    ]
    const result = selectForInjection(records, { ...options, maxTotalBytes: 500 })

    expect(result.records.map((item) => item.threadId)).toEqual(["newest"])
    expect(result.omitted).toBe(2)
  })

  test("sorts by freshness descending and breaks ties by threadId ascending deterministically", () => {
    const records = [
      record("b", { sourceUpdatedAt: 1000 }),
      record("a", { sourceUpdatedAt: 1000 }),
      record("c", { sourceUpdatedAt: 2000 }),
    ]

    const result = selectForInjection(records, options)
    expect(result.records.map((item) => item.threadId)).toEqual(["c", "a", "b"])
    expect(selectForInjection([...records].reverse(), options).records.map((item) => item.threadId)).toEqual([
      "c",
      "a",
      "b",
    ])
  })

  test("returns an empty selection for empty input", () => {
    expect(selectForInjection([], options)).toEqual({ records: [], omitted: 0 })
  })

  test("re-checks redaction on selected records as defense in depth", () => {
    const secret = "sk-abcdefgh1234"
    const result = selectForInjection([record("t", { rawMemory: `token is ${secret}`, rolloutSummary: "" })], options)

    expect(result.records[0]?.rawMemory).not.toContain(secret)
    expect(result.records[0]?.rawMemory).toContain("[REDACTED]")
  })
})
