export * as SessionExecution from "./execution"

import { Cause, Context, Duration, Effect, Exit, Layer, Option } from "effect"
import { LayerNode } from "../effect/layer-node"
import { Node } from "../effect/app-node"
import { SessionRunner } from "./runner/index"
import { SessionSchema } from "./schema"
import type { Coordinator } from "./run-coordinator"

export interface TerminalRunResult {
  readonly status: "completed" | "failed" | "cancelled" | "timed_out" | "budget_exhausted"
  readonly usage: { readonly tokens: number; readonly turns: number; readonly elapsedMs: number }
  readonly summary?: string
  readonly artifactIds: readonly string[]
  readonly changedPaths: readonly string[]
  readonly testSummary?: string
  readonly blockedReason?: string
}

export interface SupervisionInput {
  readonly sessionID: SessionSchema.ID
  readonly maxTokens: number
  readonly maxTurns: number
  readonly timeoutMs: number
}

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Interrupt active work owned by this process. Idle interruption is a no-op. */
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Runs a Session through the existing runner with bounded terminal supervision. */
  readonly supervise: (input: SupervisionInput) => Effect.Effect<TerminalRunResult, Error>
}

export const supervise = (
  coordinator: Coordinator<SessionSchema.ID, SessionRunner.RunError, SessionRunner.RunResult, SessionRunner.Limits>,
  input: SupervisionInput,
): Effect.Effect<TerminalRunResult, Error> =>
  Effect.gen(function* () {
    if (![input.maxTokens, input.maxTurns, input.timeoutMs].every((value) => Number.isSafeInteger(value) && value > 0))
      return yield* Effect.fail(new Error("maxTokens, maxTurns, and timeoutMs must be positive integers"))
    const started = Date.now()
    const run = coordinator
      .run(input.sessionID, { maxTokens: input.maxTokens, maxTurns: input.maxTurns })
      .pipe(Effect.exit)
    const result = yield* run.pipe(Effect.timeoutOption(Duration.millis(input.timeoutMs)))
    const elapsedMs = Date.now() - started
    if (Option.isNone(result)) {
      yield* coordinator.interrupt(input.sessionID)
      return { status: "timed_out", usage: { tokens: 0, turns: 0, elapsedMs }, artifactIds: [], changedPaths: [] }
    }
    if (Exit.isSuccess(result.value)) {
      const runResult = result.value.value
      return {
        status: runResult.status,
        usage: { ...runResult.usage, elapsedMs },
        artifactIds: [],
        changedPaths: runResult.changedPaths,
      }
    }
    const cancelled = Cause.hasInterruptsOnly(result.value.cause)
    return {
      status: cancelled ? "cancelled" : "failed",
      usage: { tokens: 0, turns: 0, elapsedMs },
      artifactIds: [],
      changedPaths: [],
      ...(cancelled ? {} : { blockedReason: String(Cause.squash(result.value.cause)) }),
    }
  })

/** Routes execution from a Session ID to the runner owned by that Session's Location. */
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionExecution") {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    supervise: () => Effect.fail(new Error("Session execution is unavailable")),
  }),
)
