import { describe, expect, test } from "bun:test"
import { findRelevantMemories, type MemorySelector } from "../src/retrieve"
import type { MemoryHeader } from "../src/types"

const header = (filename: string, description: string): MemoryHeader => ({
  filename,
  filePath: `/mem/${filename}`,
  mtimeMs: 1000,
  description,
  type: "project",
})

const headers = [header("bun.md", "Use bun"), header("test.md", "Run tests"), header("deploy.md", "Deploy steps")]

describe("findRelevantMemories", () => {
  test("returns the selector's valid filenames as RelevantMemory", async () => {
    const selector: MemorySelector = async () => ["bun.md", "test.md"]
    const result = await findRelevantMemories("how do I build", headers, selector)
    expect(result.map((memory) => memory.path)).toEqual(["/mem/bun.md", "/mem/test.md"])
  })

  test("drops hallucinated filenames not in the scanned set", async () => {
    const selector: MemorySelector = async () => ["bun.md", "nonexistent.md"]
    const result = await findRelevantMemories("query", headers, selector)
    expect(result.map((memory) => memory.path)).toEqual(["/mem/bun.md"])
  })

  test("caps at 5 results", async () => {
    const many = Array.from({ length: 10 }, (_, i) => header(`f${i}.md`, `desc ${i}`))
    const selector: MemorySelector = async () => many.map((header) => header.filename)
    const result = await findRelevantMemories("query", many, selector)
    expect(result).toHaveLength(5)
  })

  test("fails closed to [] when the selector throws", async () => {
    const selector: MemorySelector = async () => {
      throw new Error("LLM down")
    }
    const result = await findRelevantMemories("query", headers, selector)
    expect(result).toEqual([])
  })

  test("returns [] when there are no memories", async () => {
    const selector: MemorySelector = async () => ["anything.md"]
    const result = await findRelevantMemories("query", [], selector)
    expect(result).toEqual([])
  })
})
