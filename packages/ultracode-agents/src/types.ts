import type { TaskDeliverable } from "./events-client"

export type TaskState = "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "budget_exhausted"

export type ForkMode = "none" | "recent" | "full"

export interface ExpectedDeliverable {
  readonly name: string
  readonly requiredFields: readonly string[]
}

export interface TaskInput {
  readonly rootId: string
  readonly workspaceDirectory?: string
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

export type TaskTerminalOutcome = {
  readonly taskId: string
  readonly state: "completed" | "failed" | "cancelled" | "budget_exhausted"
  readonly deliverable?: TaskDeliverable
}

export class WaitTimeoutError extends Error {
  readonly _tag = "WaitTimeoutError"
  readonly pending: readonly string[]
  constructor(pending: readonly string[], message?: string) {
    super(message ?? `waitForTasks timed out with pending tasks: ${pending.join(", ")}`)
    this.name = "WaitTimeoutError"
    this.pending = pending
  }
}

export class UnknownTaskError extends Error {
  readonly _tag = "UnknownTaskError"
  constructor(message = "waitForTasks encountered an unknown task id") {
    super(message)
    this.name = "UnknownTaskError"
  }
}
