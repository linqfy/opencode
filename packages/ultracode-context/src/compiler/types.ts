export type BlockStability =
  | "immutable"
  | "session-stable"
  | "repository-stable"
  | "registry-stable"
  | "turn-stable"
  | "dynamic"

export type Trust = "privileged" | "untrusted"

export interface ContextBlock {
  readonly id: string
  readonly stability: BlockStability
  readonly trust: Trust
  readonly content: string
  readonly estimatedTokens: number
  readonly provenance: string
  readonly inclusionReason: string
}

export interface Budget {
  readonly modelContextLimit: number
  readonly outputReserve: number
  readonly fixedSafety: number
  readonly inputBudget: number
  readonly fixedInput: number
  readonly flexibleBudget: number
}

export interface FlexibleAllocation {
  readonly recentTail: number
  readonly evidence: number
  readonly checkpoint: number
  readonly manifests: number
}

export interface ContextPlan {
  readonly blocks: readonly ContextBlock[]
  readonly modelContextLimit: number
  readonly outputReserve: number
  readonly userContentTokens: number
  readonly endpointSafetyAllowance?: number
}

export interface CompiledBlock {
  readonly id: string
  readonly stability: BlockStability
  readonly fingerprint: string
  readonly content: string
  readonly tokens: number
}

export interface CompiledPrompt {
  readonly system: readonly string[]
  readonly blocks: readonly CompiledBlock[]
  readonly cacheBoundary: number
  readonly fingerprint: string
  readonly totalTokens: number
  readonly budget: Budget
}
