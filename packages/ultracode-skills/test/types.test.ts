import { describe, expect, test } from "bun:test"
import { skillIdentity, type Skill } from "../src/types"

describe("skillIdentity", () => {
  test("formats fully-qualified identity as source-namespace/name@version", () => {
    const skill: Skill = {
      name: "pdf",
      namespace: "ms-office-suite",
      source: "plugin",
      version: "1.2.0",
      description: "Work with PDFs",
      content: "# body",
      contentHash: "a".repeat(64),
      location: "/skills/pdf/SKILL.md",
      tokens: 100,
    }
    expect(skillIdentity(skill)).toBe("plugin:ms-office-suite/pdf@1.2.0")
  })

  test("omits namespace and version when absent", () => {
    const skill: Skill = {
      name: "build",
      source: "user",
      description: "Build it",
      content: "# body",
      contentHash: "b".repeat(64),
      location: "/u/build/SKILL.md",
      tokens: 10,
    }
    expect(skillIdentity(skill)).toBe("user:build")
  })
})
