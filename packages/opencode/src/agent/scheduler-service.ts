import path from "path"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { EventsClient, resolveSidecarBin, type EventServiceConfig } from "@ultracode/events-client"
import { createScheduler } from "@ultracode/agents"
import { Global } from "@opencode-ai/core/global"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import type { Node } from "@opencode-ai/core/effect/layer-node"
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
  | "ping"
  | "stop"
  | "listTasks"
  | "listMailbox"
  | "listTaskDeliverables"
  | "proposeCommit"
  | "queryTaskGraph"
  | "queryTaskDeliverables"
  | "listApprovalHistory"
  | "replay"
  | "statArtifact"
  | "openRange"
  | "cancelTask"
  | "enqueueMemoryJob"
  | "claimMemoryJob"
  | "completeMemoryJob"
  | "listMemoryRecords"
  | "getMemoryRecord"
  | "deleteMemoryRecord"
  | "patchMemoryRecord"
>

export type MemoryJobClient = Pick<
  EventsClient,
  "enqueueMemoryJob" | "claimMemoryJob" | "completeMemoryJob"
>

type ReadClient = Pick<
  SchedulerClient,
  "queryTaskGraph" | "queryTaskDeliverables" | "listApprovalHistory" | "replay" | "statArtifact" | "openRange" | "cancelTask" | "listMemoryRecords" | "getMemoryRecord" | "deleteMemoryRecord" | "patchMemoryRecord"
>

export type ReadApi = {
  readonly taskGraph: (input: { rootId: string; workspaceDirectory: string; cursor?: string; limit?: number }) => ReturnType<ReadClient["queryTaskGraph"]>
  readonly approvals: (input: { workspaceDirectory: string; projectId?: string; cursor?: string; limit?: number }) => ReturnType<ReadClient["listApprovalHistory"]>
  readonly deliverables: (input: { rootId: string; workspaceDirectory: string; cursor?: string; limit?: number }) => ReturnType<ReadClient["queryTaskDeliverables"]>
  readonly replay: (input: { session: string; sinceSeq?: number; limit?: number }) => ReturnType<ReadClient["replay"]>
  readonly artifact: (input: { artifactId: string; scope: string }) => ReturnType<ReadClient["statArtifact"]>
  readonly artifactRange: (input: { artifactId: string; scope: string; start?: number; end?: number }) => ReturnType<ReadClient["openRange"]>
  readonly cancel: (input: {
    rootId: string
    taskId: string
    workspaceDirectory: string
    reason: string
    idempotencyKey: string
  }) => ReturnType<ReadClient["cancelTask"]>
  readonly listMemoryRecords: (input: { limit?: number }) => ReturnType<ReadClient["listMemoryRecords"]>
  readonly getMemoryRecord: (input: { threadId: string }) => ReturnType<ReadClient["getMemoryRecord"]>
  readonly deleteMemoryRecord: (input: { threadId: string }) => ReturnType<ReadClient["deleteMemoryRecord"]>
  readonly patchMemoryRecord: (input: {
    threadId: string
    patch: { rawMemory?: string; rolloutSummary?: string; rolloutSlug?: string }
  }) => ReturnType<ReadClient["patchMemoryRecord"]>
}

type Runtime = {
  readonly parentLocation: () => Effect.Effect<ChildLocation>
  readonly worktree: Worktree.Interface
  readonly session: ChildSessionBoundary
  readonly execution: ChildExecutionBoundary
}

export interface Interface {
  readonly adapter: Effect.Effect<TaskSchedulerAdapter, Error>
  readonly read: Effect.Effect<ReadApi, Error>
  readonly events: Effect.Effect<MemoryJobClient, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SchedulerService") {}

export class SchedulerUnavailableError extends Error {
  readonly _tag = "SchedulerUnavailableError"
  constructor(message: string) {
    super(message)
    this.name = "SchedulerUnavailableError"
  }
}

export function createReadApi(client: ReadClient, adapter?: TaskSchedulerAdapter): ReadApi {
  return {
    taskGraph: (input) => client.queryTaskGraph(input.rootId, input.workspaceDirectory, input.cursor, input.limit),
    approvals: (input) => client.listApprovalHistory(input.workspaceDirectory, input.projectId, input.cursor, input.limit),
    deliverables: (input) => client.queryTaskDeliverables(input.rootId, input.workspaceDirectory, input.cursor, input.limit),
    replay: (input) => client.replay(input.session, input.sinceSeq, input.limit),
    artifact: (input) => client.statArtifact(input.artifactId, input.scope),
    artifactRange: (input) => client.openRange(input.artifactId, input.scope, input.start, input.end),
    // The adapter derives its own cancellation key (task:<root>:<task>:cancel) so it pairs with
    // finalize's acknowledgement key; the caller's idempotencyKey and workspaceDirectory are only
    // used by the degraded sidecar path below.
    cancel: (input) =>
      adapter
        ? Effect.runPromise(adapter.cancel({ rootId: input.rootId, taskId: input.taskId, reason: input.reason }))
        : client.cancelTask(input.rootId, input.taskId, input.workspaceDirectory, input.reason, input.idempotencyKey),
    listMemoryRecords: (input) => client.listMemoryRecords(input.limit),
    getMemoryRecord: (input) => client.getMemoryRecord(input.threadId),
    deleteMemoryRecord: (input) => client.deleteMemoryRecord(input.threadId),
    patchMemoryRecord: (input) => client.patchMemoryRecord(input.threadId, input.patch),
  }
}

export function eventServicePaths() {
  const state = path.join(Global.Path.state, "ultracode-events")
  return {
    journalDir: path.join(state, "journal"),
    db: path.join(state, "events.db"),
    artifacts: path.join(Global.Path.data, "ultracode-events", "artifacts"),
  }
}

export const layerWith = (input: {
  readonly sidecarBin: string
  readonly paths: Pick<EventServiceConfig, "journalDir" | "db" | "artifacts">
  readonly start: (config: EventServiceConfig) => SchedulerClient
  readonly runtime: Runtime
  readonly audit?: EventV2.Interface
}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const adapter = yield* Effect.cached(
        Effect.acquireRelease(
          Effect.gen(function* () {
            const client = input.start({ ...input.paths, sidecarBin: input.sidecarBin, session: "opencode" })
            const unsubscribe = input.audit
              ? yield* input.audit.listen((event) => {
                  if (event.type !== PermissionV2.Event.Replied.type) return Effect.void
                  const data = event.data as EventV2.Data<typeof PermissionV2.Event.Replied>
                  return Effect.tryPromise({
                    try: () => client.proposeCommit(`approval:${data.requestID}`, {
                      kind: "approval-finalized",
                      data: {
                        approval_id: data.requestID, session_id: data.sessionID, reply: data.reply,
                        decision: data.reply === "reject" ? "deny" : "allow",
                        profile: data.decision.profile ?? null, profile_version: data.decision.profileVersion ?? null,
                        grant_scope: data.grant?.scope ?? null, grant_resources: data.grant?.resources ?? [],
                        expires_at: data.grant?.expiresAt ?? null, agent: data.decision.agent ?? null,
                        turn: data.decision.turn ?? null, recorded_at: Date.now(),
                        workspace_directory: data.workspaceDirectory,
                        project_id: data.projectID,
                      },
                    }),
                    catch: (error) => error instanceof Error ? error : new Error(String(error)),
                  }).pipe(Effect.asVoid, Effect.orDie)
                })
              : undefined
            return { client, unsubscribe }
          }),
          ({ client, unsubscribe }) => (unsubscribe ?? Effect.void).pipe(Effect.ensuring(Effect.sync(() => client.stop()))),
        )
          .pipe(
            Effect.tap(({ client }) =>
              Effect.tryPromise({
                try: () => client.ping(),
                catch: (error) => (error instanceof Error ? error : new Error(String(error))),
              }).pipe(
                Effect.flatMap((result) =>
                  result.ok ? Effect.void : Effect.fail(new Error("ultracode-events sidecar ping failed")),
                ),
              ),
            ),
            Effect.flatMap(({ client }) =>
              Effect.succeed({
                client,
                adapter: createTaskSchedulerAdapter({
                  scheduler: createScheduler(client),
                  worktree: createWorktreeLeaseAdapter(input.runtime.parentLocation, input.runtime.worktree),
                  child: createChildSessionAdapter({
                    session: input.runtime.session,
                    execution: input.runtime.execution,
                  }),
                }),
              }),
            ),
          )
          .pipe(Effect.provideService(Scope.Scope, scope)),
      )
      return Service.of({
        adapter: adapter.pipe(Effect.map((value) => value.adapter)),
        read: adapter.pipe(Effect.map((value) => createReadApi(value.client, value.adapter))),
        events: adapter.pipe(Effect.map((value) => value.client)),
      })
    }),
  )

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const resolved = yield* Effect.tryPromise({
      try: () => resolveSidecarBin({ env: process.env }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, message: error.message }),
        onSuccess: (bin) => ({ ok: true as const, bin }),
      }),
    )
    if (!resolved.ok) {
      return degradedLayer(`ultracode-events sidecar unavailable: ${resolved.message}`)
    }
    const worktree = yield* Worktree.Service
    const audit = yield* EventV2.Service
    return layerWith({
      sidecarBin: resolved.bin,
      paths: eventServicePaths(),
      start: EventsClient.start,
      audit,
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

function degradedLayer(message: string) {
  return Layer.effect(
    Service,
    Effect.succeed(
      Service.of({
        adapter: Effect.fail(new SchedulerUnavailableError(message)),
        read: Effect.fail(new SchedulerUnavailableError(message)),
        events: Effect.fail(new SchedulerUnavailableError(message)),
      }),
    ),
  )
}

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [Worktree.node, EventV2.node],
}) as unknown as Node<Service, never>

export * as SchedulerService from "./scheduler-service"
