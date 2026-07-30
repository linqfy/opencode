import { describe, expect, test } from "bun:test"
import { renderMemoryMessages, MAX_MEMORY_BYTES, MAX_MEMORY_LINES, type MemoryContentReader } from "../src/render"
import type { RelevantMemory } from "../src/types"

const memory = (path: string, mtimeMs = Date.now()): RelevantMemory => ({ path, mtimeMs })

describe("renderMemoryMessages", () => {
  test("renders a memory with a header and system-reminder wrapper", async () => {
    const reader: MemoryContentReader = async () => ({ content: "# Memory body", truncated: false })
    const rendered = await renderMemoryMessages([memory("/mem/bun.md")], reader)
    expect(rendered).toHaveLength(1)
    expect(rendered[0]?.content).toContain("# Memory body")
    expect(rendered[0]?.content).toContain("<system-reminder>")
    expect(rendered[0]?.header).toContain("bun.md")
  })

  test("adds a freshness note for old memories", async () => {
    const reader: MemoryContentReader = async () => ({ content: "body", truncated: false })
    const old = memory("/mem/old.md", Date.now() - 10 * 86_400_000)
    const rendered = await renderMemoryMessages([old], reader)
    expect(rendered[0]?.content).toContain("10 days old")
  })

  test("skips memories the reader cannot read", async () => {
    const reader: MemoryContentReader = async () => undefined
    const rendered = await renderMemoryMessages([memory("/mem/x.md")], reader)
    expect(rendered).toEqual([])
  })

  test("exposes the truncation caps", () => {
    expect(MAX_MEMORY_LINES).toBe(200)
    expect(MAX_MEMORY_BYTES).toBe(4096)
  })
})
