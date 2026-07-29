// Planner-local message model + typed checkpoint schema (spec section 8).
// Claude's message types are stubbed in the leaked source and cannot be copied;
// this minimal model is reconstructed from structural usage (see audit).

export type PlannerRole = "user" | "assistant" | "system" | "tool"
export type PartKind = "text" | "tool_use" | "tool_result" | "reasoning" | "media"
export type Trust = "privileged" | "untrusted"

export interface PlannerPart {
  readonly id: string
  readonly kind: PartKind
  readonly text: string
  readonly tokens: number
  readonly toolName?: string
  readonly toolCallId?: string
  // Protection tags set by the integration layer (it knows the semantics).
  readonly userAuthored?: boolean
  readonly permissionOrConstraint?: boolean
  readonly invokedSkill?: boolean
  readonly currentTask?: boolean
  readonly activeFailure?: boolean
  // Set when microcompact/prune clears this part's content.
  readonly cleared?: boolean
}

export interface PlannerMessage {
  readonly id: string
  readonly role: PlannerRole
  readonly parts: readonly PlannerPart[]
  readonly tokens: number
}

export interface CheckpointDecision {
  readonly choice: string
  readonly reason: string
  readonly evidence?: string
}
export interface CheckpointWorkingSetItem {
  readonly path: string
  readonly symbol?: string
  readonly hash?: string
}
export interface CheckpointFact {
  readonly claim: string
  readonly source: string
  readonly confidence: number
  readonly trust: Trust
}
export interface CheckpointTest {
  readonly command: string
  readonly status: string
  readonly outputRef?: string
}

export interface CompactionCheckpoint {
  readonly objective: string
  readonly completed: readonly string[]
  readonly constraints: readonly string[]
  readonly decisions: readonly CheckpointDecision[]
  readonly workingSet: readonly CheckpointWorkingSetItem[]
  readonly facts: readonly CheckpointFact[]
  readonly toolArtifacts: readonly string[]
  readonly tests: readonly CheckpointTest[]
  readonly errors: readonly string[]
  readonly pending: readonly string[]
  readonly approvalState: readonly string[]
  readonly agentLineage: readonly string[]
  readonly worldStateBaseline?: string
  readonly recentTailStartId?: string
}

export interface CompactionConfig {
  readonly contextLimit: number
  readonly outputReserve: number
  readonly bufferTokens: number
  readonly keepRecentToolResults: number
  readonly keepRecentTurns: number
  readonly oversizedResultTokens: number
  readonly compactableTools: readonly string[]
}

// Defaults mirror Claude Code's autocompact constants (audit: autoCompact.ts,
// microCompact.ts) plus the spec's "latest two turns" protection.
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  contextLimit: 200_000,
  outputReserve: 20_000,
  bufferTokens: 13_000,
  keepRecentToolResults: 5,
  keepRecentTurns: 2,
  oversizedResultTokens: 2_000,
  compactableTools: ["read", "bash", "grep", "glob", "websearch", "webfetch", "edit", "write"],
}

export interface CompactionResult {
  readonly messages: readonly PlannerMessage[]
  readonly checkpoint: CompactionCheckpoint
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly clearedPartIds: readonly string[]
}

// Injected seams — the integration layer (Stage 3b-2) provides real ones.
export type SummarizeFn = (
  messages: readonly PlannerMessage[],
) => Promise<CompactionCheckpoint> | CompactionCheckpoint
export type ArtifactPreviewFn = (part: PlannerPart) => PlannerPart

export interface CompactionDeps {
  readonly summarize: SummarizeFn
  readonly artifactPreview: ArtifactPreviewFn
}
