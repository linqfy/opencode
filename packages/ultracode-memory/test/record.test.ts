import { describe, expect, test } from "bun:test"
import { rankForConsolidation, type MemoryRecord } from "../src/record"

const record = (over: Partial<MemoryRecord>): MemoryRecord => ({
  threadId: "thread_1",
  sourceUpdatedAt: 1000,
  rawMemory: "raw",
  rolloutSummary: "summary",
  rolloutSlug: undefined,
  cwd: "/repo",
  gitBranch: undefined,
  generatedAt: 1000,
  usageCount: 0,
  lastUsage: undefined,
  ...over,
})

describe("rankForConsolidation", () => {
  test("ranks by usage count first, then recency", () => {
    const unused_recent = record({ threadId: "a", usageCount: 0, sourceUpdatedAt: 3000 })
    const used_old = record({ threadId: "b", usageCount: 5, sourceUpdatedAt: 1000, lastUsage: 1000 })
    const used_more = record({ threadId: "c", usageCount: 10, sourceUpdatedAt: 500, lastUsage: 500 })
    const ranked = rankForConsolidation([unused_recent, used_old, used_more])
    expect(ranked.map((r) => r.threadId)).toEqual(["c", "b", "a"])
  })

  test("breaks usage ties by recency (last_usage or source_updated_at)", () => {
    const older = record({ threadId: "old", usageCount: 3, sourceUpdatedAt: 1000, lastUsage: 1000 })
    const newer = record({ threadId: "new", usageCount: 3, sourceUpdatedAt: 2000, lastUsage: 2000 })
    const ranked = rankForConsolidation([older, newer])
    expect(ranked.map((r) => r.threadId)).toEqual(["new", "old"])
  })

  test("filters out records with empty raw_memory and rollout_summary", () => {
    const empty = record({ threadId: "empty", rawMemory: "  ", rolloutSummary: "" })
    const kept = record({ threadId: "kept", rawMemory: "content" })
    const ranked = rankForConsolidation([empty, kept])
    expect(ranked.map((r) => r.threadId)).toEqual(["kept"])
  })
})
