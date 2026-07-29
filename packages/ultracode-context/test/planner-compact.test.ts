import { describe, expect, test } from "bun:test"
import { compactConversation, dedupeIdenticalBlocks, replaceOversizedWithPreviews } from "../src/planner/compact"
import { DEFAULT_COMPACTION_CONFIG, type CompactionCheckpoint, type PlannerMessage, type PlannerPart } from "../src/planner/types"

const text = (id: string, content: string, tokens = 10): PlannerPart => ({ id, kind: "text", text: content, tokens })
const result = (id: string, tokens: number): PlannerPart => ({ id, kind: "tool_result", toolName: "read", text: "x".repeat(10), tokens })
const message = (id: string, parts: PlannerPart[]): PlannerMessage => ({ id, role: "assistant", parts, tokens: parts.reduce((s, p) => s + p.tokens, 0) })

const EMPTY_CHECKPOINT: CompactionCheckpoint = {
  objective: "", completed: [], constraints: [], decisions: [], workingSet: [], facts: [],
  toolArtifacts: [], tests: [], errors: [], pending: [], approvalState: [], agentLineage: [],
}

describe("dedupeIdenticalBlocks", () => {
  test("removes consecutive duplicate text blocks within a message", () => {
    const deduped = dedupeIdenticalBlocks([message("m", [text("a", "same"), text("b", "same"), text("c", "diff")])])
    expect(deduped[0]?.parts.map((p) => p.id)).toEqual(["a", "c"])
  })
})

describe("replaceOversizedWithPreviews", () => {
  test("applies the artifact-preview seam to oversized tool results only", () => {
    const config = { ...DEFAULT_COMPACTION_CONFIG, oversizedResultTokens: 100 }
    const previewed = replaceOversizedWithPreviews(
      [message("m", [result("small", 50), result("big", 500)])],
      config,
      (part) => ({ ...part, text: "[artifact preview]", tokens: 5, cleared: true }),
    )
    expect(previewed[0]?.parts[0]?.text).toBe("x".repeat(10))
    expect(previewed[0]?.parts[1]?.text).toBe("[artifact preview]")
  })
})

describe("compactConversation", () => {
  test("runs all stages and returns the injected checkpoint with token accounting", async () => {
    const config = { ...DEFAULT_COMPACTION_CONFIG, oversizedResultTokens: 100, keepRecentToolResults: 1, keepRecentTurns: 1 }
    const history: PlannerMessage[] = [
      { id: "u1", role: "user", parts: [], tokens: 1 },
      message("a1", [result("old", 500)]),
      { id: "u2", role: "user", parts: [], tokens: 1 },
      message("a2", [result("recent", 500)]),
    ]
    const compacted = await compactConversation(history, config, {
      summarize: () => ({ ...EMPTY_CHECKPOINT, objective: "summarized" }),
      artifactPreview: (part) => ({ ...part, text: "[preview]", tokens: 5, cleared: true }),
    })
    expect(compacted.checkpoint.objective).toBe("summarized")
    expect(compacted.tokensBefore).toBeGreaterThan(0)
    expect(compacted.tokensAfter).toBeLessThan(compacted.tokensBefore)
    expect(compacted.messages.length).toBe(4)
  })
})
