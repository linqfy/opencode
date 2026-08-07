import { describe, expect, test } from "bun:test"
import { Planner } from "@ultracode/context"

const text = (id: string, content: string, tokens = 10): Planner.PlannerPart => ({ id, kind: "text", text: content, tokens })
const result = (id: string, toolName: string, over: Partial<Planner.PlannerPart> = {}): Planner.PlannerPart => ({ id, kind: "tool_result", text: "big output", tokens: 100, toolName, ...over })
const userMsg = (id: string): Planner.PlannerMessage => ({ id, role: "user", parts: [], tokens: 1 })
const assistantMsg = (id: string, parts: Planner.PlannerPart[]): Planner.PlannerMessage => ({ id, role: "assistant", parts, tokens: parts.reduce((sum, p) => sum + p.tokens, 0) })

describe("dedupeIdenticalBlocks", () => {
  test("removes exact duplicate text parts within a message, consecutive or not", () => {
    const deduped = Planner.dedupeIdenticalBlocks([assistantMsg("m", [text("a", "same"), text("b", "same"), text("c", "diff"), text("d", "same")])])
    expect(deduped[0]?.parts.map((p) => p.id)).toEqual(["a", "c"])
  })
  test("leaves distinct text and non-text parts untouched", () => {
    const parts = [result("r", "read"), { id: "t", kind: "tool_use" as const, text: "tu", tokens: 5 }, text("e", "diff")]
    const deduped = Planner.dedupeIdenticalBlocks([assistantMsg("m", parts)])
    expect(deduped[0]?.parts).toEqual(parts)
  })
  test("does not dedupe across messages", () => {
    const deduped = Planner.dedupeIdenticalBlocks([assistantMsg("m1", [text("a", "same")]), assistantMsg("m2", [text("b", "same")])])
    expect(deduped.map((m) => m.parts.length)).toEqual([1, 1])
  })
})

describe("replaceOversizedWithPreviews", () => {
  const config = { ...Planner.DEFAULT_COMPACTION_CONFIG, oversizedResultTokens: 100 }
  test("replaces only tool_result parts strictly above the threshold via the seam", () => {
    const called: string[] = []
    const previewed = Planner.replaceOversizedWithPreviews(
      [assistantMsg("m", [result("small", "read", { tokens: 50 }), result("big", "read", { tokens: 500 }), result("edge", "read", { tokens: 100 }), result("over", "read", { tokens: 101 })])],
      config,
      (part) => {
        called.push(part.id)
        return { ...part, text: "[artifact preview]", tokens: 5, cleared: true }
      },
    )
    expect(previewed[0]?.parts.map((p) => p.text)).toEqual(["big output", "[artifact preview]", "big output", "[artifact preview]"])
    expect(called).toEqual(["big", "over"])
  })
  test("does not touch non-tool_result parts or already-cleared results", () => {
    const called: string[] = []
    const parts: Planner.PlannerPart[] = [text("t", "note"), result("cleared", "read", { tokens: 5000, cleared: true }), { id: "tu", kind: "tool_use" as const, text: "x", tokens: 1 }]
    const previewed = Planner.replaceOversizedWithPreviews(
      [assistantMsg("m", parts)],
      config,
      (part) => {
        called.push(part.id)
        return { ...part, text: "[preview]", tokens: 5, cleared: true }
      },
    )
    expect(previewed[0]?.parts).toEqual(parts)
    expect(called).toEqual([])
  })
})

describe("microCompact", () => {
  const config = Planner.DEFAULT_COMPACTION_CONFIG
  test("keeps the last 5 compactable tool results and clears older ones outside the 2-turn tail", () => {
    const history = [
      userMsg("u1"),
      assistantMsg("a1", [result("r1", "read"), result("r2", "read"), result("r3", "read"), result("r4", "read"), result("r5", "read"), result("r6", "read")]),
      userMsg("u2"),
      assistantMsg("a2", [result("r7", "read")]),
      userMsg("u3"),
      assistantMsg("a3", [result("r8", "bash")]),
    ]
    const { messages, clearedPartIds } = Planner.microCompact(history, config)
    expect(clearedPartIds).toEqual(["r1", "r2", "r3"])
    const a1Parts = messages[1]?.parts ?? []
    expect(a1Parts.map((p) => p.text)).toEqual([Planner.CLEARED_MESSAGE, Planner.CLEARED_MESSAGE, Planner.CLEARED_MESSAGE, "big output", "big output", "big output"])
    expect(a1Parts[0]).toMatchObject({ tokens: 4, cleared: true })
    expect(messages[3]?.parts[0]?.text).toBe("big output")
    expect(messages[5]?.parts[0]?.text).toBe("big output")
  })
  test("never clears non-compactable or unnamed tool results", () => {
    const history = [
      userMsg("u1"),
      assistantMsg("a1", [result("custom", "some_custom_tool"), { id: "unnamed", kind: "tool_result" as const, text: "x", tokens: 100 }]),
      userMsg("u2"),
      assistantMsg("a2", [result("recent", "read")]),
      userMsg("u3"),
      assistantMsg("a3", [result("recent2", "read")]),
    ]
    const { messages, clearedPartIds } = Planner.microCompact(history, config)
    expect(clearedPartIds).toEqual([])
    expect(messages[1]?.parts.map((p) => p.text)).toEqual(["big output", "x"])
  })
  test("never clears a part carrying any protection tag", () => {
    const history = [
      userMsg("u1"),
      assistantMsg("a1", [
        result("u", "read", { userAuthored: true }),
        result("p", "read", { permissionOrConstraint: true }),
        result("i", "read", { invokedSkill: true }),
        result("c", "read", { currentTask: true }),
        result("f", "read", { activeFailure: true }),
        result("plain", "read"),
      ]),
      userMsg("u2"),
      assistantMsg("a2", [result("t1", "read"), result("t2", "read"), result("t3", "read")]),
      userMsg("u3"),
      assistantMsg("a3", [result("t4", "read"), result("t5", "read")]),
    ]
    const { messages, clearedPartIds } = Planner.microCompact(history, config)
    expect(clearedPartIds).toEqual(["plain"])
    const a1Parts = messages[1]?.parts ?? []
    expect(a1Parts.slice(0, 5).every((p) => p.text === "big output")).toBe(true)
    expect(a1Parts[5]?.text).toBe(Planner.CLEARED_MESSAGE)
  })
  test("does not re-clear an already-cleared part", () => {
    const history = [
      userMsg("u1"),
      assistantMsg("a1", [result("done", "read", { cleared: true, text: Planner.CLEARED_MESSAGE, tokens: 4 })]),
      userMsg("u2"),
      assistantMsg("a2", [result("t1", "read"), result("t2", "read"), result("t3", "read")]),
      userMsg("u3"),
      assistantMsg("a3", [result("t4", "read"), result("t5", "read")]),
    ]
    const { messages, clearedPartIds } = Planner.microCompact(history, config)
    expect(clearedPartIds).toEqual([])
    expect(messages[1]?.parts[0]).toMatchObject({ text: Planner.CLEARED_MESSAGE, tokens: 4, cleared: true })
  })
  test("protects the last two user turns from clearing", () => {
    const history = [
      userMsg("u1"),
      assistantMsg("a1", [result("x1", "read")]),
      userMsg("u2"),
      assistantMsg("a2", [result("t1", "read"), result("t2", "read"), result("t3", "read")]),
      userMsg("u3"),
      assistantMsg("a3", [result("t4", "read"), result("t5", "read"), result("t6", "read")]),
    ]
    const { messages, clearedPartIds } = Planner.microCompact(history, config)
    expect(clearedPartIds).toEqual(["x1"])
    expect(messages[1]?.parts[0]?.text).toBe(Planner.CLEARED_MESSAGE)
    expect(messages[3]?.parts.map((p) => p.text)).toEqual(["big output", "big output", "big output"])
    expect(messages[5]?.parts.map((p) => p.text)).toEqual(["big output", "big output", "big output"])
  })
  test("preserves message ordering and roles", () => {
    const history = [userMsg("u1"), assistantMsg("a1", [result("r1", "read")]), userMsg("u2"), assistantMsg("a2", [result("r2", "read")]), userMsg("u3"), assistantMsg("a3", [result("r3", "read")])]
    const { messages } = Planner.microCompact(history, config)
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"])
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"])
  })
})

describe("compactConversation", () => {
  test("runs dedupe -> preview -> microcompact -> retoken -> summarize and returns the injected checkpoint verbatim", async () => {
    const config = Planner.DEFAULT_COMPACTION_CONFIG
    const history: Planner.PlannerMessage[] = [
      { id: "u1", role: "user", parts: [], tokens: 1 },
      {
        id: "a1",
        role: "assistant",
        parts: [text("txt_a", "dup content", 30), text("txt_b", "dup content", 30), result("big", "read", { tokens: 5000 }), result("small", "read", { tokens: 100 }), result("stale", "read", { tokens: 100 })],
        tokens: 5260,
      },
      { id: "u2", role: "user", parts: [], tokens: 1 },
      { id: "a2", role: "assistant", parts: [result("recent1", "read"), result("recent2", "read"), result("recent3", "read")], tokens: 300 },
      { id: "u3", role: "user", parts: [], tokens: 1 },
      { id: "a3", role: "assistant", parts: [result("recent4", "read"), result("recent5", "read")], tokens: 200 },
    ]
    const checkpoint: Planner.CompactionCheckpoint = {
      objective: "summarized",
      completed: [],
      constraints: [],
      decisions: [],
      workingSet: [],
      facts: [],
      toolArtifacts: [],
      tests: [],
      errors: [],
      pending: [],
      approvalState: [],
      agentLineage: [],
    }
    const summarizeCalls: Array<readonly Planner.PlannerMessage[]> = []
    const compacted = await Planner.compactConversation(history, config, {
      artifactPreview: (part) => ({ ...part, text: "[preview]", tokens: 50, cleared: true }),
      summarize: (messages) => {
        summarizeCalls.push(messages)
        return checkpoint
      },
    })
    expect(compacted.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"])
    expect(compacted.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"])
    const a1Parts = compacted.messages[1]?.parts ?? []
    expect(a1Parts.map((p) => p.id)).toEqual(["txt_a", "big", "small", "stale"])
    expect(a1Parts[1]?.text).toBe("[preview]")
    expect(a1Parts[2]?.text).toBe(Planner.CLEARED_MESSAGE)
    expect(a1Parts[3]?.text).toBe(Planner.CLEARED_MESSAGE)
    expect(a1Parts[2]).toMatchObject({ tokens: 4, cleared: true })
    expect(compacted.messages[1]?.tokens).toBe(88)
    expect(compacted.tokensBefore).toBe(5763)
    expect(compacted.tokensAfter).toBe(588)
    expect(compacted.tokensAfter).toBe(compacted.messages.reduce((sum, m) => sum + m.tokens, 0))
    expect(compacted.clearedPartIds).toEqual(["small", "stale"])
    expect(compacted.checkpoint).toBe(checkpoint)
    expect(summarizeCalls).toHaveLength(1)
    expect(summarizeCalls[0]?.[1]?.tokens).toBe(88)
    expect(summarizeCalls[0]?.[1]?.parts.map((p) => p.text)).toEqual(["dup content", "[preview]", Planner.CLEARED_MESSAGE, Planner.CLEARED_MESSAGE])
  })
})

describe("protection", () => {
  test("isPartProtected returns true for every tag and false for an untagged part", () => {
    const tagged = { id: "p", kind: "tool_result" as const, text: "x", tokens: 1 }
    expect(Planner.isPartProtected({ ...tagged, userAuthored: true })).toBe(true)
    expect(Planner.isPartProtected({ ...tagged, permissionOrConstraint: true })).toBe(true)
    expect(Planner.isPartProtected({ ...tagged, invokedSkill: true })).toBe(true)
    expect(Planner.isPartProtected({ ...tagged, currentTask: true })).toBe(true)
    expect(Planner.isPartProtected({ ...tagged, activeFailure: true })).toBe(true)
    expect(Planner.isPartProtected(tagged)).toBe(false)
  })
  test("recentTailStart returns the keepRecentTurns-th-from-last user index, flooring at 0", () => {
    const history: Planner.PlannerMessage[] = [
      { id: "u1", role: "user", parts: [], tokens: 1 },
      { id: "a1", role: "assistant", parts: [], tokens: 1 },
      { id: "u2", role: "user", parts: [], tokens: 1 },
      { id: "a2", role: "assistant", parts: [], tokens: 1 },
      { id: "u3", role: "user", parts: [], tokens: 1 },
    ]
    expect(Planner.recentTailStart(history, 2)).toBe(2)
    expect(Planner.recentTailStart(history, 1)).toBe(4)
    expect(Planner.recentTailStart(history, 10)).toBe(0)
    expect(Planner.recentTailStart([], 2)).toBe(0)
  })
})
