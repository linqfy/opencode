import { computeBudget } from "./budget"
import { fingerprint } from "./fingerprint"
import type { CompiledBlock, CompiledPrompt, ContextPlan } from "./types"

export class CompilerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CompilerError"
  }
}

const STABILITY_RANK: Record<string, number> = {
  immutable: 0,
  "session-stable": 1,
  "repository-stable": 2,
  "registry-stable": 3,
  "turn-stable": 4,
  dynamic: 5,
}

const CACHE_STABLE = new Set(["immutable", "session-stable", "repository-stable", "registry-stable"])

const NON_REDUCIBLE = new Set(["immutable", "session-stable", "repository-stable"])

const stabilityRank = (stability: string): number => STABILITY_RANK[stability] ?? 6

// Pure: validates trust/channel + budget, orders deterministically, fingerprints.
// Retrieves nothing, prunes nothing, compacts nothing, injects no facts.
export const compileContext = (plan: ContextPlan): CompiledPrompt => {
  for (const block of plan.blocks) {
    if (block.trust === "untrusted" && (block.stability === "immutable" || block.stability === "session-stable")) {
      throw new CompilerError(`untrusted block "${block.id}" cannot occupy privileged stability "${block.stability}"`)
    }
  }

  const fixedInput =
    plan.blocks.filter((block) => NON_REDUCIBLE.has(block.stability)).reduce((sum, block) => sum + block.estimatedTokens, 0) +
    plan.userContentTokens
  const budget = computeBudget(plan.modelContextLimit, plan.outputReserve, fixedInput, plan.endpointSafetyAllowance ?? 0)

  if (fixedInput > budget.inputBudget) {
    throw new CompilerError(`non-reducible input (${fixedInput} tokens) exceeds input budget (${budget.inputBudget})`)
  }

  const ordered = [...plan.blocks].sort(
    (a, b) => stabilityRank(a.stability) - stabilityRank(b.stability) || a.id.localeCompare(b.id),
  )
  const blocks: CompiledBlock[] = ordered.map((block) => ({
    id: block.id,
    stability: block.stability,
    fingerprint: fingerprint({ id: block.id, content: block.content }),
    content: block.content,
    tokens: block.estimatedTokens,
  }))

  const firstDynamic = blocks.findIndex((block) => !CACHE_STABLE.has(block.stability))
  const cacheBoundary = firstDynamic === -1 ? blocks.length : firstDynamic

  return {
    system: blocks.map((block) => block.content),
    blocks,
    cacheBoundary,
    fingerprint: fingerprint(blocks.map((block) => block.fingerprint)),
    totalTokens: blocks.reduce((sum, block) => sum + block.tokens, 0) + plan.userContentTokens,
    budget,
  }
}
