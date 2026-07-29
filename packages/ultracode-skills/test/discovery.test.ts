import { describe, expect, test } from "bun:test"
import { loadSkillFromMarkdown } from "../src/discovery"

describe("loadSkillFromMarkdown", () => {
  test("builds a Skill record with content hash and token estimate", () => {
    const md = `---
name: pdf
description: Work with PDFs
version: 1.0.0
---
# Body content`
    const skill = loadSkillFromMarkdown(md, { location: "/skills/pdf/SKILL.md", source: "user", namespace: undefined })
    expect(skill?.name).toBe("pdf")
    expect(skill?.source).toBe("user")
    expect(skill?.version).toBe("1.0.0")
    expect(skill?.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(skill?.tokens).toBeGreaterThan(0)
    expect(skill?.content.trim()).toBe("# Body content")
  })

  test("derives name from the directory when frontmatter lacks one", () => {
    const skill = loadSkillFromMarkdown("# body", { location: "/skills/my-skill/SKILL.md", source: "directory", namespace: undefined })
    expect(skill?.name).toBe("my-skill")
  })

  test("returns undefined when no name can be derived", () => {
    const skill = loadSkillFromMarkdown("# body", { location: "/SKILL.md", source: "directory", namespace: undefined })
    expect(skill).toBeUndefined()
  })

  test("carries allowed-tools and when_to_use metadata", () => {
    const md = `---
name: build
allowed-tools: read, bash
when_to_use: When building
---
body`
    const skill = loadSkillFromMarkdown(md, { location: "/skills/build/SKILL.md", source: "user", namespace: undefined })
    expect(skill?.allowedTools).toEqual(["read", "bash"])
    expect(skill?.whenToUse).toBe("When building")
  })
})
