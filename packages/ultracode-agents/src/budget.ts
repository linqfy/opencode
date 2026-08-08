import type { Result, TaskState } from "./types"

export interface BudgetInput {
  readonly total: number
  readonly fixedCosts: number
}

export interface BudgetState {
  readonly total: number
  readonly fixedCosts: number
  readonly remainingTotal: number
  readonly parentAllocation: number
  readonly childPoolAllocation: number
  readonly synthesisReserve: number
  readonly childSpent: number
  readonly synthesisSpent: number
  readonly childReclaimed: number
}

export type BudgetError =
  | "negative_budget"
  | "fixed_costs_exceed_total"
  | "non_integral_allocation"
  | "invalid_spend_amount"
  | "child_budget_exhausted"
  | "synthesis_budget_exhausted"
  | "children_not_terminal"

export function createBudget(input: BudgetInput): Result<BudgetState, BudgetError> {
  if (!Number.isInteger(input.total) || !Number.isInteger(input.fixedCosts) || input.total < 0 || input.fixedCosts < 0) {
    return { ok: false, error: "negative_budget" }
  }
  if (input.fixedCosts > input.total) return { ok: false, error: "fixed_costs_exceed_total" }

  const remainingTotal = input.total - input.fixedCosts
  if (remainingTotal % 10 !== 0) return { ok: false, error: "non_integral_allocation" }

  return {
    ok: true,
    value: {
      total: input.total,
      fixedCosts: input.fixedCosts,
      remainingTotal,
      parentAllocation: (remainingTotal * 60) / 100,
      childPoolAllocation: (remainingTotal * 30) / 100,
      synthesisReserve: (remainingTotal * 10) / 100,
      childSpent: 0,
      synthesisSpent: 0,
      childReclaimed: 0,
    },
  }
}

export function spendChildBudget(state: BudgetState, amount: number): Result<BudgetState, BudgetError> {
  if (!isNonNegativeInteger(amount)) return { ok: false, error: "invalid_spend_amount" }
  if (state.childSpent + amount > state.childPoolAllocation) return { ok: false, error: "child_budget_exhausted" }

  return { ok: true, value: { ...state, childSpent: state.childSpent + amount } }
}

export function spendSynthesisBudget(
  state: BudgetState,
  amount: number,
  childStates: readonly TaskState[],
): Result<BudgetState, BudgetError> {
  if (!allChildrenTerminal(childStates)) return { ok: false, error: "children_not_terminal" }
  if (!isNonNegativeInteger(amount)) return { ok: false, error: "invalid_spend_amount" }
  if (state.synthesisSpent + amount > state.synthesisReserve) return { ok: false, error: "synthesis_budget_exhausted" }

  return { ok: true, value: { ...state, synthesisSpent: state.synthesisSpent + amount } }
}

export function reclaimUnusedChildBudget(
  state: BudgetState,
  childStates: readonly TaskState[],
): Result<BudgetState, BudgetError> {
  if (!allChildrenTerminal(childStates)) return { ok: false, error: "children_not_terminal" }

  return {
    ok: true,
    value: {
      ...state,
      childReclaimed: state.childPoolAllocation - state.childSpent,
    },
  }
}

function isNonNegativeInteger(value: number) {
  return Number.isInteger(value) && value >= 0
}

function allChildrenTerminal(states: readonly TaskState[]) {
  return states.every(
    (state) => state === "completed" || state === "failed" || state === "cancelled" || state === "budget_exhausted",
  )
}
