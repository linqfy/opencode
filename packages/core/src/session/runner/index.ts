export * as SessionRunner from "./index"

import type { LLMError } from "@opencode-ai/llm"
import { Context, Effect } from "effect"
import { SessionSchema } from "../schema"
import type { ContextSnapshotDecodeError, MessageDecodeError } from "../error"
import { SessionRunnerModel } from "./model"
import type { SystemContext } from "../../system-context/index"
import type { ToolOutputStore } from "../../tool-output-store"

export type RunError =
  | LLMError
  | SessionRunnerModel.Error
  | MessageDecodeError
  | ContextSnapshotDecodeError
  | SystemContext.InitializationBlocked
  | ToolOutputStore.Error

export interface Limits {
  readonly maxTokens: number
  readonly maxTurns: number
}

export interface RunResult {
  readonly status: "completed" | "budget_exhausted"
  readonly usage: { readonly tokens: number; readonly turns: number }
  readonly changedPaths: readonly string[]
}

/** Runs one local continuation from already-recorded Session history. */
export interface Interface {
  /** Drains eligible durable work. Explicit runs perform one provider attempt even when no work is eligible. */
  readonly run: (input: {
    readonly sessionID: SessionSchema.ID
    readonly force: boolean
    readonly limits?: Limits
  }) => Effect.Effect<RunResult, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunner") {}
