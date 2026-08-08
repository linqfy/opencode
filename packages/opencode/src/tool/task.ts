import { Agent } from "@/agent/agent"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { WaitTimeoutError } from "@ultracode/agents"
import type { ForkMode, TaskTerminalOutcome } from "@ultracode/agents"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import type { MessageID, SessionID } from "../session/schema"
import type { SessionPrompt } from "../session/prompt"

/** @deprecated Task execution is owned by TaskSchedulerAdapter. */
export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<unknown>
}

export interface TaskSchedulerAdapter {
  schedule(input: TaskSchedulerAdapter.Input): Effect.Effect<TaskSchedulerAdapter.Handle, Error>
  cancel(input: {
    rootId: string
    taskId: string
    reason: string
  }): Effect.Effect<TaskSchedulerAdapter.Cancellation, Error>
  wait(input: { rootId: string; taskId: string; timeoutMs: number }): Effect.Effect<TaskTerminalOutcome, Error>
}

export namespace TaskSchedulerAdapter {
  export interface Input {
    readonly brief: string
    readonly description: string
    readonly agent: {
      readonly name: string
      readonly model: { readonly modelID: string; readonly providerID: string }
      readonly toolConstraints: readonly string[]
      readonly permissionConstraints?: PermissionV1.Ruleset
    }
    readonly forkMode: ForkMode
    readonly budget: { readonly maxTurns: number; readonly maxTokens: number; readonly maxTimeMs: number }
    readonly background: boolean
    readonly requestedTaskId?: string
    readonly parent: {
      readonly rootId: string
      readonly taskId: string
      readonly sessionID: SessionID
      readonly messageID: MessageID
      readonly workspaceDirectory?: string
    }
  }

  export interface Evidence {
    readonly summary: string
    readonly artifactIds: readonly string[]
    readonly changedPaths: readonly string[]
    readonly testSummary?: string
    readonly blockedReason?: string
  }

  export interface Handle {
    readonly rootId: string
    readonly taskId: string
    readonly status: "pending" | "running" | "waiting" | "completed"
    readonly summary: string
    readonly evidence: Evidence
  }

  export interface Cancellation {
    readonly state: "cancelled" | "cancellation_pending" | "budget_exhausted"
  }
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true schedules the subagent asynchronously and returns its task handle.",
  "Foreground is the default; it returns the scheduler's current bounded deliverable or status handle.",
].join(" ")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  maxTurns: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: "Execution budget: maximum number of agent turns",
  }),
  maxTokens: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: "Execution budget: maximum number of tokens",
  }),
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: "Execution budget: maximum runtime in milliseconds",
  }),
  waitMs: Schema.optional(Schema.Int.check(Schema.isLessThanOrEqualTo(600_000))).annotate({
    description: "Wait up to this many milliseconds for a terminal task outcome; returns the deliverable summary",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description: "Set this only to resume a previous scheduler task.",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description: "Run the agent in the background and return its scheduler task handle",
  }),
})

function renderOutput(handle: TaskSchedulerAdapter.Handle) {
  return [
    `<task id="${handle.taskId}" state="${handle.status}">`,
    `<summary>${handle.summary}</summary>`,
    "<task_result>",
    handle.evidence.summary,
    ...(handle.evidence.artifactIds.length ? [`Artifacts: ${handle.evidence.artifactIds.join(", ")}`] : []),
    ...(handle.evidence.changedPaths.length ? [`Changed paths: ${handle.evidence.changedPaths.join(", ")}`] : []),
    ...(handle.evidence.testSummary ? [`Tests: ${handle.evidence.testSummary}`] : []),
    ...(handle.evidence.blockedReason ? [`Blocked: ${handle.evidence.blockedReason}`] : []),
    "</task_result>",
    "</task>",
  ].join("\n")
}

function renderOutcome(outcome: TaskTerminalOutcome) {
  const deliverable = outcome.deliverable
  const summary = (deliverable?.summary ?? outcome.state).slice(0, 4_096)
  const changedPaths = deliverable?.changed_paths ?? []
  return [
    `<task id="${outcome.taskId}" state="${outcome.state}">`,
    `<summary>${summary}</summary>`,
    "<task_result>",
    summary,
    ...(changedPaths.length ? [`Changed paths: ${changedPaths.join(", ")}`] : []),
    "</task_result>",
    "</task>",
  ].join("\n")
}

function renderTimedOut(handle: TaskSchedulerAdapter.Handle, waitMs: number) {
  return [
    `<task id="${handle.taskId}" state="running">`,
    `<summary>Task is still running after ${waitMs}ms; task id: ${handle.taskId}</summary>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: { description: params.description, subagent_type: params.subagent_type },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next)
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      const scheduler = ctx.extra?.schedulerAdapter as TaskSchedulerAdapter | undefined
      if (!scheduler) return yield* Effect.fail(new Error("TaskTool requires schedulerAdapter in ctx.extra"))

      const model = next.model ?? (ctx.extra?.model as { modelID: string; providerID: string } | undefined)
      if (!model) return yield* Effect.fail(new Error("TaskTool requires a model in ctx.extra"))
      const parent = yield* agent.get(ctx.agent)
      if (!parent) return yield* Effect.fail(new Error(`Unknown invoking agent: ${ctx.agent}`))
      const policy = deriveChildPolicy({ parent, child: next })
      const handle = yield* scheduler.schedule({
        brief: params.prompt,
        description: params.description,
        agent: { name: next.name, model, ...policy },
        forkMode: params.task_id ? "recent" : "none",
        budget: { maxTurns: params.maxTurns, maxTokens: params.maxTokens, maxTimeMs: params.timeoutMs },
        background: runInBackground,
        ...(params.task_id ? { requestedTaskId: params.task_id } : {}),
        parent: {
          rootId: ctx.sessionID,
          taskId: ctx.messageID,
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          workspaceDirectory: ctx.extra?.workspaceDirectory as string | undefined,
        },
      })
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: handle.taskId,
        taskId: handle.taskId,
        model,
        ...(runInBackground ? { background: true } : {}),
        artifactIds: handle.evidence.artifactIds,
      }
      yield* ctx.metadata({ title: params.description, metadata })

      const cancel = () => scheduler.cancel({ rootId: handle.rootId, taskId: handle.taskId, reason: "parent aborted" })
      const onAbort = () => void Effect.runFork(cancel())
      ctx.abort.addEventListener("abort", onAbort, { once: true })
      if (params.waitMs === undefined) return { title: params.description, metadata, output: renderOutput(handle) }

      const outcome = yield* scheduler
        .wait({ rootId: handle.rootId, taskId: handle.taskId, timeoutMs: params.waitMs })
        .pipe(
          Effect.catchIf(
            (error): error is WaitTimeoutError => error instanceof WaitTimeoutError,
            () => Effect.succeed(undefined),
          ),
        )
      if (outcome === undefined)
        return { title: params.description, metadata, output: renderTimedOut(handle, params.waitMs) }
      return { title: params.description, metadata, output: renderOutcome(outcome) }
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

function selectedTools(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return []
  return value
}

export function deriveChildPolicy(input: { readonly parent: Agent.Info; readonly child: Agent.Info }) {
  const parentTools = selectedTools(input.parent.options.tools)
  const childTools = selectedTools(input.child.options.tools)
  if (parentTools.length > 0 && childTools.some((tool) => !parentTools.includes(tool))) {
    throw new Error("child cannot expand parent tool constraints")
  }
  for (const rule of input.child.permission) {
    if (rule.action !== "allow") continue
    const parentRule = input.parent.permission.findLast(
      (candidate) => candidate.permission === rule.permission && candidate.pattern === rule.pattern,
    )
    if (parentRule?.action !== "allow") throw new Error("child cannot expand parent permission constraints")
  }
  return {
    toolConstraints: childTools.length > 0 ? childTools : parentTools,
    permissionConstraints: [
      ...input.child.permission,
      ...input.parent.permission.filter((rule) => rule.action !== "allow"),
    ] satisfies PermissionV1.Ruleset,
  }
}
