import { describe, expect, test } from "bun:test"
import { applyFeedback } from "../src/feedback"
import { InMemoryMemoryStore } from "../src/store"
import type { MemoryRecord } from "../src/record"
import type { MemoryStore } from "../src/store"

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
    expect(result.failed).toBe(false)
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
    expect(result.failed).toBe(false)
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
    expect(result.failed).toBe(false)
  })

  test("drives ranking: credited thread jumps above higher-recency uncredited", async () => {
    const store = new InMemoryMemoryStore()
    await store.upsert(record("recent", { sourceUpdatedAt: 5000 }))
    await store.upsert(record("old", { sourceUpdatedAt: 1000 }))
    await applyFeedback(`<memory-citation thread_id="old"/>`, store, 6000)
    const ranked = (await store.selectForConsolidation(2)).map((r) => r.threadId)
    expect(ranked).toEqual(["old", "recent"])
  })

  test("fails closed when listing records fails while retaining parsed citations", async () => {
    const store: MemoryStore = {
      upsert: async () => {},
      list: async () => {
        throw new Error("storage unavailable")
      },
      recordUsage: async () => {},
      selectForConsolidation: async () => [],
    }

    await expect(applyFeedback(`<memory-citation thread_id="t1"/>`, store, 5000)).resolves.toEqual({
      citations: [{ threadId: "t1" }],
      credited: [],
      unknown: [],
      failed: true,
    })
  })

  test("fails closed when recording usage fails without crediting ids", async () => {
    const store: MemoryStore = {
      upsert: async () => {},
      list: async () => [record("t1")],
      recordUsage: async () => {
        throw new Error("storage unavailable")
      },
      selectForConsolidation: async () => [],
    }

    await expect(
      applyFeedback(`<memory-citation thread_id="t1"/><memory-citation thread_id="ghost"/>`, store, 5000),
    ).resolves.toEqual({
      citations: [{ threadId: "t1" }, { threadId: "ghost" }],
      credited: [],
      unknown: ["ghost"],
      failed: true,
    })
  })
})
