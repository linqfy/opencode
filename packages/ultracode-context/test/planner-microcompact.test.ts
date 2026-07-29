import { describe, expect, test } from "bun:test"
import { CLEARED_MESSAGE, microCompact } from "../src/planner/microCompact"
import { DEFAULT_COMPACTION_CONFIG, type PlannerMessage, type PlannerPart } from "../src/planner/types"
const result = (id: string, toolName: string, over: Partial<PlannerPart> = {}): PlannerPart => ({ id, kind: "tool_result", text: "big output", tokens: 100, toolName, ...over })
const userMsg = (id: string): PlannerMessage => ({ id, role: "user", parts: [], tokens: 1 })
const assistantMsg = (id: string, parts: PlannerPart[]): PlannerMessage => ({ id, role: "assistant", parts, tokens: parts.reduce((s, p) => s + p.tokens, 0) })
const config = { ...DEFAULT_COMPACTION_CONFIG, keepRecentToolResults: 1, keepRecentTurns: 1 }
describe("microCompact", () => {
  test("clears old compactable tool results but keeps the most recent", () => { const history = [userMsg("u1"), assistantMsg("a1", [result("old", "read")]), userMsg("u2"), assistantMsg("a2", [result("recent", "read")])]; const { messages, clearedPartIds } = microCompact(history, config); expect(messages[1]?.parts[0]?.text).toBe(CLEARED_MESSAGE); expect(messages[1]?.parts[0]?.cleared).toBe(true); expect(messages[3]?.parts[0]?.text).toBe("big output"); expect(clearedPartIds).toEqual(["old"]) })
  test("never clears a non-compactable tool result", () => { const { messages } = microCompact([userMsg("u1"), assistantMsg("a1", [result("x", "some_custom_tool")]), userMsg("u2"), assistantMsg("a2", [result("y", "read")])], config); expect(messages[1]?.parts[0]?.text).toBe("big output") })
  test("never clears a protected part even if old and compactable", () => { const { messages } = microCompact([userMsg("u1"), assistantMsg("a1", [result("active-err", "bash", { activeFailure: true })]), userMsg("u2"), assistantMsg("a2", [result("recent", "read")])], config); expect(messages[1]?.parts[0]?.text).toBe("big output") })
  test("does not clear inside the recent tail", () => { const { messages, clearedPartIds } = microCompact([userMsg("u1"), assistantMsg("a1", [result("intail", "read")])], { ...config, keepRecentTurns: 2 }); expect(messages[1]?.parts[0]?.text).toBe("big output"); expect(clearedPartIds).toEqual([]) })
})
