import { describe, expect, test } from "bun:test"
import { applyFeedback } from "../src/feedback"
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

describe("applyFeedback", () => {
  test("credits known thread ids and reports unknown ones", async () => {
    const store = new InMemoryMemoryStore()
    await store.upsert(record("t1"))
    const result = await applyFeedback(
      `<memory-citation thread_id="t1"/><memory-citation thread_id="ghost"/>`,
      store,
      5000,
    )
    expect(result.credited).toEqual(["t1"])
    expect(result.unknown).toEqual(["ghost"])
    const stored = await store.list()
    expect(stored[0]?.usageCount).toBe(1)
    expect(stored[0]?.lastUsage).toBe(5000)
  })

  test("does not call recordUsage when no citations are known", async () => {
    const store = new InMemoryMemoryStore()
    await store.upsert(record("t1"))
    const result = await applyFeedback(`<memory-citation thread_id="ghost"/>`, store, 5000)
    expect(result.credited).toEqual([])
    expect(result.unknown).toEqual(["ghost"])
    const stored = await store.list()
    expect(stored[0]?.usageCount).toBe(0)
  })

  test("returns citations and unknown unchanged for downstream visibility", async () => {
    const store = new InMemoryMemoryStore()
    await store.upsert(record("t1"))
    const result = await applyFeedback(
      `<memory-citation thread_id="t1"/><memory-citation thread_id="ghost"/>`,
      store,
      5000,
    )
    expect(result.citations.map((c) => c.threadId)).toEqual(["t1", "ghost"])
  })

  test("drives ranking: credited thread jumps above higher-recency uncredited", async () => {
    const store = new InMemoryMemoryStore()
    await store.upsert(record("recent", { sourceUpdatedAt: 5000 }))
    await store.upsert(record("old", { sourceUpdatedAt: 1000 }))
    await applyFeedback(`<memory-citation thread_id="old"/>`, store, 6000)
    const ranked = (await store.selectForConsolidation(2)).map((r) => r.threadId)
    expect(ranked).toEqual(["old", "recent"])
  })
})
