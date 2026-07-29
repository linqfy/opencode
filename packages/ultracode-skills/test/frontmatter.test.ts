import { describe, expect, test } from "bun:test"
import { parseSkillMarkdown } from "../src/frontmatter"

describe("parseSkillMarkdown", () => {
  test("splits frontmatter from body and parses fields", () => {
    const md = `---
name: pdf
description: Work with PDFs
allowed-tools: read, bash
version: 1.2.0
---
# Skill body here`
    const parsed = parseSkillMarkdown(md)
    expect(parsed.frontmatter.name).toBe("pdf")
    expect(parsed.frontmatter.description).toBe("Work with PDFs")
    expect(parsed.frontmatter.version).toBe("1.2.0")
    expect(parsed.content.trim()).toBe("# Skill body here")
  })

  test("returns empty frontmatter when there is none", () => {
    const parsed = parseSkillMarkdown("# Just a body")
    expect(parsed.frontmatter).toEqual({})
    expect(parsed.content.trim()).toBe("# Just a body")
  })

  test("parses allowed-tools as a list", () => {
    const parsed = parseSkillMarkdown(`---
allowed-tools:
  - read
  - bash
---
body`)
    expect(parsed.frontmatter["allowed-tools"]).toEqual(["read", "bash"])
  })
})
