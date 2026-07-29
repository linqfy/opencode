import type { Budget, FlexibleAllocation } from "./types"

export const FIXED_SAFETY_FRACTION = 0.05

export const computeBudget = (
  modelContextLimit: number,
  outputReserve: number,
  fixedInput: number,
  endpointSafetyAllowance = 0,
): Budget => {
  const fixedSafety = Math.max(endpointSafetyAllowance, Math.ceil(modelContextLimit * FIXED_SAFETY_FRACTION))
  const inputBudget = modelContextLimit - outputReserve - fixedSafety
  const flexibleBudget = Math.max(0, inputBudget - fixedInput)
  return { modelContextLimit, outputReserve, fixedSafety, inputBudget, fixedInput, flexibleBudget }
}

// 35/45/15/5 ceilings; manifests absorbs the rounding remainder so the four
// parts sum EXACTLY to flexibleBudget (spec: allocations sum to 100%).
export const allocateFlexible = (flexibleBudget: number): FlexibleAllocation => {
  const recentTail = Math.floor(flexibleBudget * 0.35)
  const evidence = Math.floor(flexibleBudget * 0.45)
  const checkpoint = Math.floor(flexibleBudget * 0.15)
  const manifests = flexibleBudget - recentTail - evidence - checkpoint
  return { recentTail, evidence, checkpoint, manifests }
}
