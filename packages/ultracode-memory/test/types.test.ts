import { describe, expect, test } from "bun:test"
import { parseMemoryType, MEMORY_TYPES, parseMemoryFrontmatter } from "../src/index"

describe("parseMemoryType", () => {
  test("accepts the four memory types", () => {
    for (const type of MEMORY_TYPES) expect(parseMemoryType(type)).toBe(type)
  })

  test("returns undefined for unknown or missing types", () => {
    expect(parseMemoryType("bogus")).toBeUndefined()
    expect(parseMemoryType(undefined)).toBeUndefined()
    expect(parseMemoryType(42)).toBeUndefined()
  })
})

describe("parseMemoryFrontmatter", () => {
  test("parses name, description, type from frontmatter", () => {
    const md = `---
name: bun-version
description: Use bun 1.3 in this repo
type: project
---
# Body`
    const parsed = parseMemoryFrontmatter(md)
    expect(parsed.name).toBe("bun-version")
    expect(parsed.description).toBe("Use bun 1.3 in this repo")
    expect(parsed.type).toBe("project")
    expect(parsed.content.trim()).toBe("# Body")
  })

  test("returns empty fields when there is no frontmatter", () => {
    const parsed = parseMemoryFrontmatter("# Just a body")
    expect(parsed.name).toBeUndefined()
    expect(parsed.description).toBeUndefined()
    expect(parsed.type).toBeUndefined()
    expect(parsed.content.trim()).toBe("# Just a body")
  })
})
