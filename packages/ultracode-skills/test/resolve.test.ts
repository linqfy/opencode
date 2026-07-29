import { describe, expect, test } from "bun:test"
import { contentHash } from "../src/discovery"
import { resolveSkills, isSafeRelativePath, containsPath } from "../src/resolve"
import type { Skill } from "../src/types"

const skill = (name: string, source: Skill["source"], content = "body"): Skill => ({
  name,
  source,
  content,
  contentHash: contentHash(content),
  location: `/${source}/${name}/SKILL.md`,
  tokens: 10,
})

describe("resolveSkills", () => {
  test("higher-precedence source wins on name collision", () => {
    const resolved = resolveSkills([skill("pdf", "bundled"), skill("pdf", "user")])
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.source).toBe("user")
  })

  test("managed beats user beats directory", () => {
    const resolved = resolveSkills([skill("x", "directory"), skill("x", "user"), skill("x", "managed")])
    expect(resolved[0]?.source).toBe("managed")
  })

  test("same name + same level + differing content is an error", () => {
    expect(() => resolveSkills([skill("x", "user", "a"), skill("x", "user", "b")])).toThrow()
  })

  test("same name + same level + identical content dedups without error", () => {
    const resolved = resolveSkills([skill("x", "user", "same"), skill("x", "user", "same")])
    expect(resolved).toHaveLength(1)
  })

  test("distinct names all survive", () => {
    const resolved = resolveSkills([skill("a", "user"), skill("b", "plugin"), skill("c", "bundled")])
    expect(resolved.map((s) => s.name).sort()).toEqual(["a", "b", "c"])
  })
})

describe("path safety", () => {
  test("rejects path traversal and absolute paths", () => {
    expect(isSafeRelativePath("../etc/passwd")).toBe(false)
    expect(isSafeRelativePath("/etc/passwd")).toBe(false)
    expect(isSafeRelativePath("a/../../b")).toBe(false)
    expect(isSafeRelativePath("scripts/run.sh")).toBe(true)
  })

  test("containsPath detects containment", () => {
    expect(containsPath("/base", "/base/sub/file")).toBe(true)
    expect(containsPath("/base", "/other/file")).toBe(false)
    expect(containsPath("/base", "/base")).toBe(true)
  })
})
