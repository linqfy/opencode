import { describe, expect, test } from "bun:test"
import { DEFAULT_COMPACTION_CONFIG, type CompactionCheckpoint } from "../src/planner/types"

describe("planner types", () => {
  test("default config carries Claude-derived buffers and protection counts", () => {
    expect(DEFAULT_COMPACTION_CONFIG.bufferTokens).toBe(13_000)
    expect(DEFAULT_COMPACTION_CONFIG.keepRecentToolResults).toBe(5)
    expect(DEFAULT_COMPACTION_CONFIG.keepRecentTurns).toBe(2)
    expect(DEFAULT_COMPACTION_CONFIG.compactableTools.length).toBeGreaterThan(0)
  })

  test("checkpoint schema accepts a fully-populated checkpoint", () => {
    const checkpoint: CompactionCheckpoint = {
      objective: "build the feature",
      completed: ["scaffold"],
      constraints: ["no new deps"],
      decisions: [{ choice: "use bun", reason: "fast", evidence: "bench" }],
      workingSet: [{ path: "src/x.ts", symbol: "foo", hash: "abc" }],
      facts: [{ claim: "tests pass", source: "bun test", confidence: 1, trust: "privileged" }],
      toolArtifacts: ["art_1"],
      tests: [{ command: "bun test", status: "pass", outputRef: "art_1" }],
      errors: [],
      pending: ["wire it"],
      approvalState: [],
      agentLineage: ["main"],
      worldStateBaseline: "base_1",
      recentTailStartId: "msg_5",
    }
    expect(checkpoint.decisions[0]?.choice).toBe("use bun")
    expect(checkpoint.facts[0]?.trust).toBe("privileged")
  })
})
