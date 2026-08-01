import { describe, expect, test } from "bun:test"
import {
  createBudget,
  reclaimUnusedChildBudget,
  spendChildBudget,
  spendSynthesisBudget,
  type BudgetInput,
  type BudgetState,
} from "../src"

const budgetInput: BudgetInput = { total: 1_000, fixedCosts: 100 }

function budget(): BudgetState {
  const result = createBudget(budgetInput)
  if (!result.ok) throw new Error(result.error)
  return result.value
}

describe("budget", () => {
  test("allocates remaining budget exactly across parent, children, and synthesis", () => {
    const result = createBudget(budgetInput)

    expect(result).toEqual({
      ok: true,
      value: {
        total: 1_000,
        fixedCosts: 100,
        remainingTotal: 900,
        parentAllocation: 540,
        childPoolAllocation: 270,
        synthesisReserve: 90,
        childSpent: 0,
        synthesisSpent: 0,
        childReclaimed: 0,
      },
    })
  })

  test("rejects negative budgets and fixed costs larger than total", () => {
    expect(createBudget({ total: -1, fixedCosts: 0 })).toEqual({ ok: false, error: "negative_budget" })
    expect(createBudget({ total: 10, fixedCosts: 11 })).toEqual({ ok: false, error: "fixed_costs_exceed_total" })
  })

  test("rejects remaining totals that cannot be allocated as exact integers", () => {
    expect(createBudget({ total: 101, fixedCosts: 0 })).toEqual({ ok: false, error: "non_integral_allocation" })
  })

  test("does not mutate frozen budget input", () => {
    const input = Object.freeze({ total: 1_000, fixedCosts: 100 })

    createBudget(input)

    expect(input).toEqual({ total: 1_000, fixedCosts: 100 })
  })

  test("prevents child spending from consuming the synthesis reserve", () => {
    const result = spendChildBudget(budget(), 271)

    expect(result).toEqual({ ok: false, error: "child_budget_exhausted" })
  })

  test("protects synthesis spending and child reclamation until every child is terminal", () => {
    const state = budget()
    const children = ["completed", "running"] as const

    expect(spendSynthesisBudget(state, 1, children)).toEqual({ ok: false, error: "children_not_terminal" })
    expect(reclaimUnusedChildBudget(state, children)).toEqual({ ok: false, error: "children_not_terminal" })
  })

  test("allows unused child allocation to be reclaimed only after every child is terminal", () => {
    const spent = spendChildBudget(budget(), 100)
    if (!spent.ok) throw new Error(spent.error)

    const result = reclaimUnusedChildBudget(spent.value, ["completed", "cancelled"])

    expect(result).toEqual({
      ok: true,
      value: {
        ...spent.value,
        childReclaimed: 170,
      },
    })
    expect(spent.value.childReclaimed).toBe(0)
  })

  test("allows synthesis spending after every child is terminal", () => {
    const result = spendSynthesisBudget(budget(), 90, ["completed"])

    expect(result).toEqual({ ok: true, value: { ...budget(), synthesisSpent: 90 } })
  })
})
