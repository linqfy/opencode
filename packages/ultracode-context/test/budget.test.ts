import { describe, expect, test } from "bun:test"
import { allocateFlexible, computeBudget, FIXED_SAFETY_FRACTION } from "../src/compiler/budget"

describe("computeBudget", () => {
  test("applies the spec budget equation", () => {
    const budget = computeBudget(200_000, 32_000, 10_000)
    // fixed_safety = max(0, ceil(200000 * 0.05)) = 10000
    expect(budget.fixedSafety).toBe(Math.ceil(200_000 * FIXED_SAFETY_FRACTION))
    // input_budget = 200000 - 32000 - 10000 = 158000
    expect(budget.inputBudget).toBe(158_000)
    // flexible_budget = 158000 - 10000 = 148000
    expect(budget.flexibleBudget).toBe(148_000)
  })

  test("uses the endpoint allowance when it exceeds 5%", () => {
    const budget = computeBudget(200_000, 32_000, 0, 40_000)
    expect(budget.fixedSafety).toBe(40_000)
    expect(budget.inputBudget).toBe(128_000)
  })

  test("flexible budget floors at zero when fixed input dominates", () => {
    const budget = computeBudget(10_000, 2_000, 9_000)
    expect(budget.flexibleBudget).toBe(0)
  })
})

describe("allocateFlexible", () => {
  test("splits 35/45/15/5 and sums exactly to the flexible budget", () => {
    for (const flexible of [0, 1, 7, 100, 148_000, 999_999]) {
      const allocation = allocateFlexible(flexible)
      expect(allocation.recentTail + allocation.evidence + allocation.checkpoint + allocation.manifests).toBe(flexible)
    }
  })

  test("respects the ratios on a clean number", () => {
    const allocation = allocateFlexible(10_000)
    expect(allocation.recentTail).toBe(3_500)
    expect(allocation.evidence).toBe(4_500)
    expect(allocation.checkpoint).toBe(1_500)
    expect(allocation.manifests).toBe(500)
  })
})
