import path from "path"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { EventsClient, type EventServiceConfig } from "@ultracode/events-client"
import { createScheduler } from "@ultracode/agents"
import { Global } from "@opencode-ai/core/global"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { InstanceState } from "@/effect/instance-state"
import { Worktree } from "@/worktree"
import {
  createChildSessionAdapter,
  createTaskSchedulerAdapter,
  createWorktreeLeaseAdapter,
  type ChildExecutionBoundary,
  type ChildLocation,
  type ChildSessionBoundary,
} from "./scheduler"
import type { TaskSchedulerAdapter } from "@/tool/task"

type SchedulerClient = Pick<
  EventsClient,
  "ping" | "stop" | "listTasks" | "listMailbox" | "listTaskDeliverables" | "proposeCommit"
>

type Runtime = {
  readonly parentLocation: () => Effect.Effect<ChildLocation>
  readonly worktree: Worktree.Interface
  readonly session: ChildSessionBoundary
  readonly execution: ChildExecutionBoundary
}

export interface Interface {
  readonly adapter: Effect.Effect<TaskSchedulerAdapter, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SchedulerService") {}

export function eventServicePaths() {
  const state = path.join(Global.Path.state, "ultracode-events")
  return {
    journalDir: path.join(state, "journal"),
    db: path.join(state, "events.db"),
    artifacts: path.join(Global.Path.data, "ultracode-events", "artifacts"),
  }
}

export function resolveSidecarBin(input: {
  readonly environment: { readonly ULTRACODE_EVENTS_SIDECAR_BIN?: string }
  readonly developmentBin: string
  readonly exists: (file: string) => boolean
}) {
  if (input.environment.ULTRACODE_EVENTS_SIDECAR_BIN) return input.environment.ULTRACODE_EVENTS_SIDECAR_BIN
  if (input.exists(input.developmentBin)) return input.developmentBin
  return undefined
}

export const layerWith = (input: {
  readonly sidecarBin: string
  readonly paths: Pick<EventServiceConfig, "journalDir" | "db" | "artifacts">
  readonly start: (config: EventServiceConfig) => SchedulerClient
  readonly runtime: Runtime
}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const adapter = yield* Effect.cached(
        Effect.acquireRelease(
          Effect.sync(() => input.start({ ...input.paths, sidecarBin: input.sidecarBin, session: "opencode" })),
          (client) => Effect.sync(() => client.stop()),
        )
          .pipe(
            Effect.tap((client) =>
              Effect.tryPromise({
                try: () => client.ping(),
                catch: (error) => (error instanceof Error ? error : new Error(String(error))),
              }).pipe(
                Effect.flatMap((result) =>
                  result.ok ? Effect.void : Effect.fail(new Error("ultracode-events sidecar ping failed")),
                ),
              ),
            ),
            Effect.flatMap((client) =>
              Effect.succeed(
                createTaskSchedulerAdapter({
                  scheduler: createScheduler(client),
                  worktree: createWorktreeLeaseAdapter(input.runtime.parentLocation, input.runtime.worktree),
                  child: createChildSessionAdapter({
                    session: input.runtime.session,
                    execution: input.runtime.execution,
                  }),
                }),
              ),
            ),
          )
          .pipe(Effect.provideService(Scope.Scope, scope)),
      )
      return Service.of({ adapter })
    }),
  )

const developmentBin = path.join(
  import.meta.dir,
  "../../../../target/debug",
  process.platform === "win32" ? "sidecar.exe" : "sidecar",
)

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const sidecarBin = resolveSidecarBin({
      environment: process.env as { readonly ULTRACODE_EVENTS_SIDECAR_BIN?: string },
      developmentBin,
      exists: (file) => Bun.file(file).size > 0,
    })
    if (!sidecarBin)
      return Layer.effect(Service, Effect.fail(new Error(`ultracode-events sidecar not found at ${developmentBin}`)))
    const exists = yield* Effect.promise(() => Bun.file(sidecarBin).exists())
    if (!exists)
      return Layer.effect(Service, Effect.fail(new Error(`ultracode-events sidecar not found at ${sidecarBin}`)))
    const worktree = yield* Worktree.Service
    return layerWith({
      sidecarBin,
      paths: eventServicePaths(),
      start: EventsClient.start,
      runtime: {
        parentLocation: () => InstanceState.context.pipe(Effect.map((ctx) => ({ directory: ctx.directory }))),
        worktree,
        session: {
          create: (input) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make()
              const context = yield* Effect.context<never>()
                const agents = Context.get(context as never, AgentV2.Service) as AgentV2.Interface
                const agent = AgentV2.ID.make(`scheduler_${input.id}`)
                return yield* agents.transform((draft) => {
                  const source = draft.get(AgentV2.ID.make(input.agent)) ?? AgentV2.Info.empty(agent)
                  draft.update(agent, (value) => {
                    Object.assign(value, source, {
                      id: agent,
                      // A child receives an allow-list, never the selected agent's full tool catalog.
                      permissions: [
                        { action: "*", resource: "*", effect: "deny" },
                        ...input.toolConstraints.map((tool) => ({ action: tool, resource: "*", effect: "allow" as const })),
                        ...(input.permissionConstraints ?? [])
                          .filter((rule) => rule.action !== "allow")
                          .map((rule) => ({ action: rule.permission, resource: rule.pattern, effect: rule.action })),
                      ],
                    })
                  })
                }).pipe(
                  Effect.andThen(() =>
                    (Context.get(context as never, SessionV2.Service) as SessionV2.Interface)
                      .create({
                    id: SessionSchema.ID.make(input.id),
                    location: input.location as never,
                    agent,
                    model: input.model as never,
                  })
                  .pipe(
                    Effect.map((value) => ({ id: value.id, close: Scope.close(scope, Exit.void) })),
                    Effect.orDie,
                  ),
                ),
                Effect.provideService(Scope.Scope, scope),
                Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void),
              )
            }),
          prompt: (input) =>
            Effect.context<never>().pipe(
              Effect.flatMap((context) =>
                (Context.get(context as never, SessionV2.Service) as SessionV2.Interface)
                  .prompt({
                    id: SessionMessage.ID.make(input.id),
                    sessionID: SessionSchema.ID.make(input.sessionID),
                    prompt: input.prompt as never,
                    resume: input.resume,
                  })
                  .pipe(Effect.orDie),
              ),
            ),
        },
        execution: {
          supervise: (input) =>
            Effect.context<never>().pipe(
              Effect.flatMap((context) =>
                (Context.get(context as never, SessionExecution.Service) as SessionExecution.Interface).supervise({
                  sessionID: SessionSchema.ID.make(input.sessionID),
                  maxTokens: input.maxTokens,
                  maxTurns: input.maxTurns,
                  timeoutMs: input.timeoutMs,
                }),
              ),
            ),
          interrupt: (sessionID) =>
            Effect.context<never>().pipe(
              Effect.flatMap((context) => {
                const execution = Context.get(context as never, SessionExecution.Service) as SessionExecution.Interface
                const id = SessionSchema.ID.make(sessionID)
                return execution.active.pipe(
                  Effect.flatMap((active) => execution.interrupt(id).pipe(Effect.as({ observed: active.has(id) }))),
                )
              }),
            ),
        },
      },
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [Worktree.node],
})

export * as SchedulerService from "./scheduler-service"
