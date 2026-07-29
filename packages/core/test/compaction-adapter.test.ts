import { describe, expect, test } from "bun:test"
import { toPlannerMessages } from "../src/session/compaction-adapter"

// Minimal SessionMessage-shaped fixtures (only the fields the adapter reads).
const user = (id: string, text: string) => ({ id, type: "user", text, time: { created: 0 } })
const assistantText = (id: string, text: string) => ({
  id, type: "assistant", agent: "build", model: { id: "m", providerID: "p" },
  content: [{ type: "text", id: `${id}-t`, text }], time: { created: 0 },
})
const assistantTool = (id: string, name: string, status: "completed" | "error") => ({
  id, type: "assistant", agent: "build", model: { id: "m", providerID: "p" },
  content: [{
    type: "tool", id: `${id}-tool`, name,
    state: status === "completed"
      ? { status: "completed", input: {}, structured: {}, content: [{ type: "text", text: "tool output" }] }
      : { status: "error", input: {}, structured: {}, content: [], error: { message: "boom" } },
    time: { created: 0 },
  }],
  time: { created: 0 },
})
const system = (id: string, text: string) => ({ id, type: "system", text, time: { created: 0 } })
const entry = (message: any, seq: number) => ({ seq, message })

describe("toPlannerMessages", () => {
  test("maps user/assistant/system messages to planner roles", () => {
    const result = toPlannerMessages([entry(user("u1", "hello"), 1), entry(assistantText("a1", "hi"), 2), entry(system("s1", "note"), 3)] as any)
    expect(result.map((m) => m.role)).toEqual(["user", "assistant", "system"])
    expect(result[0]?.parts[0]?.text).toBe("hello")
    expect(result[0]?.parts[0]?.userAuthored).toBe(true)
  })

  test("maps assistant tool calls to tool_use and tool_result parts with failure tagging", () => {
    const result = toPlannerMessages([entry(assistantTool("a1", "bash", "error"), 1)] as any)
    const parts = result[0]?.parts ?? []
    const toolUse = parts.find((p) => p.kind === "tool_use")
    const toolResult = parts.find((p) => p.kind === "tool_result")
    expect(toolUse?.toolName).toBe("bash")
    expect(toolResult?.toolName).toBe("bash")
    expect(toolResult?.activeFailure).toBe(true)
  })

  test("drops agent-switched/model-switched and estimates tokens", () => {
    const result = toPlannerMessages([
      entry({ id: "x", type: "agent-switched", time: { created: 0 } }, 1),
      entry(user("u1", "abcd".repeat(10)), 2),
    ] as any)
    expect(result.length).toBe(1)
    expect(result[0]?.tokens).toBeGreaterThan(0)
    expect(result[0]?.parts[0]?.tokens).toBe(10) // 40 chars / 4
  })
})
