import { describe, expect, test } from "bun:test"
import { formatMemoryManifest, sortHeadersNewestFirst } from "../src/scan"
import { memoryAge, memoryAgeDays, memoryFreshnessText } from "../src/age"
import type { MemoryHeader } from "../src/types"

const header = (filename: string, mtimeMs: number, description: string | null = null, type?: MemoryHeader["type"]): MemoryHeader => ({
  filename,
  filePath: `/mem/${filename}`,
  mtimeMs,
  description,
  type,
})

describe("sortHeadersNewestFirst", () => {
  test("sorts newest-first and caps at 200", () => {
    const headers = Array.from({ length: 250 }, (_, i) => header(`f${i}.md`, i))
    const sorted = sortHeadersNewestFirst(headers)
    expect(sorted).toHaveLength(200)
    expect(sorted[0]?.filename).toBe("f249.md")
  })
})

describe("formatMemoryManifest", () => {
  test("formats type tag, filename, timestamp, and description", () => {
    const manifest = formatMemoryManifest([header("bun.md", 0, "Use bun", "project")])
    expect(manifest).toContain("[project]")
    expect(manifest).toContain("bun.md")
    expect(manifest).toContain("Use bun")
  })
})

describe("memory aging", () => {
  test("memoryAgeDays floors elapsed days and clamps negative", () => {
    const now = Date.now()
    expect(memoryAgeDays(now)).toBe(0)
    expect(memoryAgeDays(now - 86_400_000)).toBe(1)
    expect(memoryAgeDays(now + 86_400_000)).toBe(0)
  })

  test("memoryAge produces human-readable strings", () => {
    const now = Date.now()
    expect(memoryAge(now)).toBe("today")
    expect(memoryAge(now - 86_400_000)).toBe("yesterday")
    expect(memoryAge(now - 5 * 86_400_000)).toBe("5 days ago")
  })

  test("memoryFreshnessText is empty for fresh, a caveat for old", () => {
    const now = Date.now()
    expect(memoryFreshnessText(now)).toBe("")
    expect(memoryFreshnessText(now - 5 * 86_400_000)).toContain("5 days old")
  })
})
