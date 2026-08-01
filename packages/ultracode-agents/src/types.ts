export type TaskState = "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled"

export type ForkMode = "none" | "recent" | "full"

export interface ExpectedDeliverable {
  readonly name: string
  readonly requiredFields: readonly string[]
}

export interface TaskInput {
  readonly rootId: string
  readonly taskId: string
  readonly parentId?: string
  readonly depth: number
  readonly stateChanging: boolean
  readonly dependencyIds: readonly string[]
  readonly requestedMaxTokens: number
  readonly requestedMaxTimeMs: number
  readonly forkMode: ForkMode
  readonly selectedEvidenceArtifactIds: readonly string[]
  readonly toolIds: readonly string[]
  readonly expectedDeliverable: ExpectedDeliverable
}

export interface Task extends TaskInput {
  readonly state: TaskState
}

export type Result<Value, Error extends string> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Error }
