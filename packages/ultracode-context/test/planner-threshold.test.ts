import { describe, expect, test } from "bun:test"
import { compactThreshold, shouldCompact, totalTokens } from "../src/planner/threshold"
import { DEFAULT_COMPACTION_CONFIG, type PlannerMessage } from "../src/planner/types"

const msg = (tokens: number): PlannerMessage => ({ id: `m${tokens}`, role: "assistant", parts: [], tokens })

describe("threshold", () => {
  test("threshold is contextLimit - outputReserve - bufferTokens", () => {
    expect(compactThreshold(DEFAULT_COMPACTION_CONFIG)).toBe(200_000 - 20_000 - 13_000)
  })

  test("shouldCompact fires at or above the threshold", () => {
    const threshold = compactThreshold(DEFAULT_COMPACTION_CONFIG)
    expect(shouldCompact(threshold - 1, DEFAULT_COMPACTION_CONFIG)).toBe(false)
    expect(shouldCompact(threshold, DEFAULT_COMPACTION_CONFIG)).toBe(true)
  })

  test("totalTokens sums message tokens", () => {
    expect(totalTokens([msg(100), msg(250)])).toBe(350)
    expect(totalTokens([])).toBe(0)
  })
})
