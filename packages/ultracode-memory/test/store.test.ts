import { describe, expect, test } from "bun:test"
import { InMemoryMemoryStore } from "../src/store"
import type { MemoryRecord } from "../src/record"

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

describe("InMemoryMemoryStore", () => {
  test("upserts by thread id (newer source_updated_at wins)", async () => {
    const store = new InMemoryMemoryStore()
    await store.upsert(record("t1", { sourceUpdatedAt: 1000, rawMemory: "old" }))
    await store.upsert(record("t1", { sourceUpdatedAt: 2000, rawMemory: "new" }))
    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.rawMemory).toBe("new")
  })

  test("ignores an upsert with an older source_updated_at", async () => {
    const store = new InMemoryMemoryStore()
    await store.upsert(record("t1", { sourceUpdatedAt: 2000, rawMemory: "new" }))
    await store.upsert(record("t1", { sourceUpdatedAt: 1000, rawMemory: "old" }))
    const all = await store.list()
    expect(all[0]?.rawMemory).toBe("new")
  })

  test("records usage and updates last_usage", async () => {
    const store = new InMemoryMemoryStore()
    await store.upsert(record("t1"))
    await store.recordUsage(["t1"], 5000)
    const all = await store.list()
    expect(all[0]?.usageCount).toBe(1)
    expect(all[0]?.lastUsage).toBe(5000)
  })

  test("selectForConsolidation ranks by usage then recency and respects the limit", async () => {
    const store = new InMemoryMemoryStore()
    await store.upsert(record("a", { usageCount: 1, sourceUpdatedAt: 1000 }))
    await store.upsert(record("b", { usageCount: 5, sourceUpdatedAt: 500 }))
    await store.upsert(record("c", { usageCount: 5, sourceUpdatedAt: 2000 }))
    const selected = await store.selectForConsolidation(2)
    expect(selected.map((r) => r.threadId)).toEqual(["c", "b"])
  })
})
