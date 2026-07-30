import { describe, expect, test } from "bun:test"
import { mapSourceToSkillSource, resolveSkillInfos, type SkillInfo } from "../src/integration"

const info = (name: string, content = "body"): SkillInfo => ({
  name,
  description: `${name} description`,
  location: `/${name}/SKILL.md`,
  content,
})

describe("mapSourceToSkillSource", () => {
  test("maps V2 source types to unified SkillSource", () => {
    expect(mapSourceToSkillSource({ type: "embedded" })).toBe("bundled")
    expect(mapSourceToSkillSource({ type: "url" })).toBe("user")
    expect(mapSourceToSkillSource({ type: "directory" })).toBe("directory")
  })
})

describe("resolveSkillInfos", () => {
  test("higher-precedence source wins on name collision", () => {
    const resolved = resolveSkillInfos([
      { info: info("pdf"), source: "bundled" },
      { info: info("pdf"), source: "user" },
    ])
    expect(resolved).toHaveLength(1)
    // the user-source skill survives (higher precedence than bundled)
    expect(resolved[0]?.name).toBe("pdf")
  })

  test("same name + same level + differing content is an error", () => {
    expect(() =>
      resolveSkillInfos([
        { info: info("x", "a"), source: "user" },
        { info: info("x", "b"), source: "user" },
      ]),
    ).toThrow()
  })

  test("same name + same level + identical content dedups", () => {
    const resolved = resolveSkillInfos([
      { info: info("x", "same"), source: "user" },
      { info: info("x", "same"), source: "user" },
    ])
    expect(resolved).toHaveLength(1)
  })

  test("distinct names all survive, sorted by name", () => {
    const resolved = resolveSkillInfos([
      { info: info("b"), source: "user" },
      { info: info("a"), source: "plugin" },
      { info: info("c"), source: "bundled" },
    ])
    expect(resolved.map((s) => s.name)).toEqual(["a", "b", "c"])
  })

  test("preserves the original SkillInfo (description/location) for survivors", () => {
    const original = info("pdf", "content")
    const resolved = resolveSkillInfos([{ info: original, source: "user" }])
    expect(resolved[0]?.description).toBe("pdf description")
    expect(resolved[0]?.location).toBe("/pdf/SKILL.md")
  })
})
