import { describe, expect, test } from "bun:test"
import { isPartProtected, recentTailStart } from "../src/planner/protect"
import type { PlannerMessage, PlannerPart } from "../src/planner/types"

const part = (over: Partial<PlannerPart> = {}): PlannerPart => ({ id: "p", kind: "tool_result", text: "x", tokens: 1, ...over })
const message = (role: PlannerMessage["role"], id: string): PlannerMessage => ({ id, role, parts: [], tokens: 1 })

describe("isPartProtected", () => {
  test("protects every tagged category", () => {
    expect(isPartProtected(part({ userAuthored: true }))).toBe(true)
    expect(isPartProtected(part({ permissionOrConstraint: true }))).toBe(true)
    expect(isPartProtected(part({ invokedSkill: true }))).toBe(true)
    expect(isPartProtected(part({ currentTask: true }))).toBe(true)
    expect(isPartProtected(part({ activeFailure: true }))).toBe(true)
  })
  test("does not protect an untagged part", () => { expect(isPartProtected(part())).toBe(false) })
})
describe("recentTailStart", () => {
  const history: PlannerMessage[] = [message("user", "u1"), message("assistant", "a1"), message("user", "u2"), message("assistant", "a2"), message("user", "u3"), message("assistant", "a3")]
  test("returns the index of the Nth-from-last user message", () => { expect(recentTailStart(history, 2)).toBe(2); expect(recentTailStart(history, 1)).toBe(4) })
  test("floors at 0 when fewer turns exist than requested", () => { expect(recentTailStart(history, 10)).toBe(0); expect(recentTailStart([], 2)).toBe(0) })
})
