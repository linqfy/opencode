import { describe, expect, test } from "bun:test"
import {
  InMemoryMemoryStore,
  consolidateMemory,
  extractMemory,
  findRelevantMemories,
  memoryFreshnessNote,
  MAX_MEMORY_BYTES,
  MAX_MEMORY_LINES,
  MAX_RELEVANT_MEMORIES,
  rankForConsolidation,
  redactSecrets,
  renderMemoryMessages,
  type MemoryConsolidator,
  type MemoryContentReader,
  type MemoryExtractor,
  type MemoryHeader,
  type MemoryRecord,
  type MemorySelector,
  type RelevantMemory,
} from "../src"

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

const header = (filename: string): MemoryHeader => ({
  filename,
  filePath: `/mem/${filename}`,
  mtimeMs: 1000,
  description: `desc ${filename}`,
  type: "project",
})

const memory = (path: string, mtimeMs = Date.now()): RelevantMemory => ({ path, mtimeMs })

describe("characterization: create/append record", () => {
  test("a new thread appends and a newer sourceUpdatedAt replaces in place", async () => {
    const store = new InMemoryMemoryStore()
    await store.upsert(record("t1", { sourceUpdatedAt: 1000, rawMemory: "v1" }))
    await store.upsert(record("t2", { sourceUpdatedAt: 1000, rawMemory: "other" }))
    expect((await store.list()).map((r) => r.threadId)).toEqual(["t1", "t2"])

    await store.upsert(record("t1", { sourceUpdatedAt: 2000, rawMemory: "v2" }))
    const all = await store.list()
    expect(all).toHaveLength(2)
    expect(all.find((r) => r.threadId === "t1")?.rawMemory).toBe("v2")
  })

  test("an upsert with an equal sourceUpdatedAt is refused (existing wins)", async () => {
    const store = new InMemoryMemoryStore()
    await store.upsert(record("t1", { sourceUpdatedAt: 2000, rawMemory: "original" }))
    await store.upsert(record("t1", { sourceUpdatedAt: 2000, rawMemory: "attempted update" }))
    const [stored] = await store.list()
    expect(stored?.rawMemory).toBe("original")
  })

  test("extract then upsert persists a record that never contains a matched secret", async () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE"
    const extractor: MemoryExtractor = async () =>
      JSON.stringify({
        raw_memory: `deploy with aws key ${awsKey}`,
        rollout_summary: `rotated token sk-rotate12345678`,
        rollout_slug: null,
      })
    const extraction = await extractMemory("transcript", extractor)
    expect(extraction).toBeDefined()
    if (!extraction) return

    const store = new InMemoryMemoryStore()
    await store.upsert({
      threadId: "memory:req-1",
      sourceUpdatedAt: 1000,
      rawMemory: extraction.rawMemory,
      rolloutSummary: extraction.rolloutSummary,
      cwd: "/repo",
      generatedAt: 1000,
      usageCount: 0,
    })
    const [stored] = await store.list()
    expect(stored?.rawMemory).not.toContain(awsKey)
    expect(stored?.rawMemory).toContain("[REDACTED]")
    expect(stored?.rolloutSummary).not.toContain("sk-rotate12345678")
  })
})

describe("characterization: freshness decay", () => {
  test("memoryFreshnessNote is empty for fresh memories and within one day", () => {
    const now = Date.now()
    expect(memoryFreshnessNote(now)).toBe("")
    expect(memoryFreshnessNote(now - 86_400_000)).toBe("")
  })

  test("memoryFreshnessNote wraps an old memory in a system-reminder with trailing newline", () => {
    const note = memoryFreshnessNote(Date.now() - 5 * 86_400_000)
    expect(note).toContain("<system-reminder>")
    expect(note).toContain("5 days old")
    expect(note.endsWith("\n")).toBe(true)
  })
})

describe("characterization: redaction on write", () => {
  test("redacts sk- keys, GitHub PATs, and AWS access keys entirely", () => {
    const skKey = "sk-abcdefgh1234"
    const ghp = "ghp_abcdefghijklmnopqrst"
    const awsKey = "AKIAIOSFODNN7EXAMPLE"
    const redacted = redactSecrets(`key ${skKey} token ${ghp} aws ${awsKey}`)
    expect(redacted).not.toContain(skKey)
    expect(redacted).not.toContain(ghp)
    expect(redacted).not.toContain(awsKey)
    expect(redacted).toContain("[REDACTED]")
  })

  test("redacts api_key/token/secret assignment forms", () => {
    const assignment = `api_key=abcdefghijklmn; api-key = 1234567890abc; token: xyzpdqabc123456; secret = 'super-secret-value-1'`
    const redacted = redactSecrets(assignment)
    expect(redacted).not.toContain("abcdefghijklmn")
    expect(redacted).not.toContain("1234567890abc")
    expect(redacted).not.toContain("xyzpdqabc123456")
    expect(redacted).not.toContain("super-secret-value-1")
    expect(redacted).toContain("[REDACTED]")
  })

  test("does not redact values below the conservative minimum lengths", () => {
    expect(redactSecrets("api_key=abc")).toBe("api_key=abc")
    expect(redactSecrets("token=short12")).toBe("token=short12")
    expect(redactSecrets("sk-x")).toBe("sk-x")
  })

  test("extractMemory redacts secrets in rawMemory, rolloutSummary, and rolloutSlug", async () => {
    const extractor: MemoryExtractor = async () =>
      JSON.stringify({
        raw_memory: "secret sk-abcdefgh1234",
        rollout_summary: "token ghp_abcdefghijklmnopqrst",
        rollout_slug: "AKIAIOSFODNN7EXAMPLE",
      })
    const result = await extractMemory("transcript", extractor)
    expect(result?.rawMemory).toContain("[REDACTED]")
    expect(result?.rolloutSummary).toContain("[REDACTED]")
    expect(result?.rolloutSlug).toContain("[REDACTED]")
  })
})

describe("characterization: retrieval caps enforced", () => {
  test("findRelevantMemories preserves selector order and caps at MAX_RELEVANT_MEMORIES", async () => {
    const many = Array.from({ length: 10 }, (_, i) => header(`f${i}.md`))
    const selector: MemorySelector = async () =>
      many.map((header) => header.filename).reverse()
    const result = await findRelevantMemories("query", many, selector)
    expect(result).toHaveLength(MAX_RELEVANT_MEMORIES)
    expect(result.map((memory) => memory.path)).toEqual([
      "/mem/f9.md",
      "/mem/f8.md",
      "/mem/f7.md",
      "/mem/f6.md",
      "/mem/f5.md",
    ])
  })

  test("findRelevantMemories excludes already-surfaced memories from selection and manifest", async () => {
    const headers = [header("a.md"), header("b.md"), header("c.md")]
    let seenManifest = ""
    const selector: MemorySelector = async (input) => {
      seenManifest = input.manifest
      return ["a.md", "b.md", "c.md"]
    }
    const result = await findRelevantMemories("query", headers, selector, [], new Set(["/mem/b.md"]))
    expect(result.map((memory) => memory.path)).toEqual(["/mem/a.md", "/mem/c.md"])
    expect(seenManifest).not.toContain("b.md")
  })

  test("renderMemoryMessages passes the line and byte caps to the reader", async () => {
    let receivedLimits: { maxLines: number; maxBytes: number } | undefined
    const reader: MemoryContentReader = async (_path, limits) => {
      receivedLimits = limits
      return { content: "body", truncated: false }
    }
    await renderMemoryMessages([memory("/mem/bun.md")], reader)
    expect(receivedLimits).toEqual({ maxLines: MAX_MEMORY_LINES, maxBytes: MAX_MEMORY_BYTES })
  })

  test("renderMemoryMessages appends a truncated notice when the reader truncates", async () => {
    const reader: MemoryContentReader = async () => ({ content: "capped body", truncated: true })
    const rendered = await renderMemoryMessages([memory("/mem/bun.md")], reader)
    expect(rendered[0]?.content).toContain("[truncated — use the file read tool to see the full memory]")
  })

  test("renderMemoryMessages renders untruncated content without a truncated notice", async () => {
    const reader: MemoryContentReader = async () => ({ content: "full body", truncated: false })
    const rendered = await renderMemoryMessages([memory("/mem/bun.md")], reader)
    expect(rendered[0]?.content).toContain("full body")
    expect(rendered[0]?.content).not.toContain("truncated")
  })
})

describe("characterization: consolidation merge", () => {
  test("rankForConsolidation breaks usage+recency ties by newer sourceUpdatedAt", () => {
    const older = record("older", { usageCount: 5, lastUsage: 9000, sourceUpdatedAt: 1000 })
    const newer = record("newer", { usageCount: 5, lastUsage: 9000, sourceUpdatedAt: 2000 })
    expect(rankForConsolidation([older, newer]).map((r) => r.threadId)).toEqual(["newer", "older"])
  })

  test("rankForConsolidation breaks remaining ties by descending thread id byte order", () => {
    const a = record("a", { sourceUpdatedAt: 1000, lastUsage: 9000, usageCount: 0 })
    const b = record("b", { sourceUpdatedAt: 1000, lastUsage: 9000, usageCount: 0 })
    const c = record("c", { sourceUpdatedAt: 1000, lastUsage: 9000, usageCount: 0 })
    expect(rankForConsolidation([a, b, c]).map((r) => r.threadId)).toEqual(["c", "b", "a"])
  })

  test("consolidateMemory merges ranked records into one memory citing its sources", async () => {
    const records = [
      record("low", { usageCount: 1, sourceUpdatedAt: 300 }),
      record("high", { usageCount: 2, sourceUpdatedAt: 100 }),
      record("empty", { rawMemory: "", rolloutSummary: "" }),
    ]
    const consolidator: MemoryConsolidator = async (selected) =>
      JSON.stringify({
        summary: "Merged summary",
        memory: `Merged from ${selected.map((r) => r.threadId).join(", ")}`,
        source_thread_ids: selected.map((r) => r.threadId),
      })
    const result = await consolidateMemory(records, consolidator)
    expect(result?.memory).toBe("Merged from high, low")
    expect(result?.sourceThreadIds).toEqual(["high", "low"])
  })
})
