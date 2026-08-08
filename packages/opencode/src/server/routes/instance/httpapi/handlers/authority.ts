import { SchedulerService } from "@/agent/scheduler-service"
import { InstanceState } from "@/effect/instance-state"
import { SessionDiagnostics } from "@opencode-ai/core/capability/diagnostics"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { AuthorityCancelPayload, AuthorityPageQuery } from "../groups/authority"

const limit = (value: number | undefined) => Math.min(200, Math.max(1, Math.floor(value ?? 100)))

export const authorityHandlers = HttpApiBuilder.group(InstanceHttpApi, "authority", (handlers) =>
  Effect.gen(function* () {
    const scheduler = yield* SchedulerService.Service
    const read = yield* scheduler.read.pipe(Effect.orDie)
    const page = (query: typeof AuthorityPageQuery.Type) => limit(query.limit)

    return handlers
      .handle("taskGraph", (ctx: { query: typeof AuthorityPageQuery.Type }) =>
        Effect.gen(function* () {
          const directory = yield* InstanceState.directory
          return yield* Effect.promise(() => read.taskGraph({
            rootId: ctx.query.rootId ?? "",
            workspaceDirectory: directory,
            cursor: ctx.query.cursor,
            limit: page(ctx.query),
          }))
        }),
      )
      .handle("cancelTask", (ctx: { params: { rootId: string }; query: typeof AuthorityPageQuery.Type; payload: typeof AuthorityCancelPayload.Type }) =>
        Effect.gen(function* () {
          const directory = yield* InstanceState.directory
          return yield* Effect.promise(() => read.cancel({
            rootId: ctx.params.rootId,
            taskId: ctx.payload.taskId,
            workspaceDirectory: directory,
            reason: ctx.payload.reason,
            idempotencyKey: ctx.payload.idempotencyKey,
          }))
        }),
      )
      .handle("approvals", (ctx: { query: typeof AuthorityPageQuery.Type }) =>
        Effect.gen(function* () {
          const directory = yield* InstanceState.directory
          return yield* Effect.promise(() => read.approvals({ workspaceDirectory: directory, projectId: ctx.query.projectId, cursor: ctx.query.cursor, limit: page(ctx.query) }))
        }),
      )
      .handle("replay", (ctx: { params: { sessionId: string }; query: typeof AuthorityPageQuery.Type }) =>
        Effect.promise(() => read.replay({ session: ctx.params.sessionId, sinceSeq: ctx.query.sinceSeq, limit: page(ctx.query) })),
      )
      .handle("context", (ctx: { params: { sessionId: string }; query: typeof AuthorityPageQuery.Type }) =>
        Effect.promise(() => read.replay({ session: ctx.params.sessionId, sinceSeq: ctx.query.sinceSeq, limit: page(ctx.query) }).then((events) => events.filter((event) => event.kind.includes("context") || event.kind.includes("prompt")))),
      )
      .handle("artifact", (ctx: { params: { artifactId: string }; query: typeof AuthorityPageQuery.Type }) =>
        Effect.gen(function* () {
          const directory = yield* InstanceState.directory
          return yield* Effect.promise(() => read.artifact({ artifactId: ctx.params.artifactId, scope: directory }))
        }),
      )
      .handle("artifactRange", (ctx: { params: { artifactId: string }; query: typeof AuthorityPageQuery.Type }) =>
        Effect.gen(function* () {
          const directory = yield* InstanceState.directory
          return yield* Effect.promise(() => read.artifactRange({ artifactId: ctx.params.artifactId, scope: directory, start: ctx.query.start, end: Math.min(ctx.query.end ?? 0, (ctx.query.start ?? 0) + 1_048_576) }).then((bytes) => ({ bytes: Array.from(bytes) })))
        }),
      )
      .handle("providers", (ctx: { query: typeof AuthorityPageQuery.Type }) =>
        Effect.promise(() => read.replay({ session: ctx.query.sessionId ?? "", sinceSeq: ctx.query.sinceSeq, limit: page(ctx.query) }).then((events) => events.filter((event) => event.kind.includes("provider")))),
      )
      .handle("plugins", (ctx: { query: typeof AuthorityPageQuery.Type }) =>
        Effect.promise(() => read.replay({ session: ctx.query.sessionId ?? "", sinceSeq: ctx.query.sinceSeq, limit: page(ctx.query) }).then((events) => events.filter((event) => event.kind.includes("tool") || event.kind.includes("plugin")))),
      )
      .handle("stepUsage", (ctx: { params: { sessionId: string }; query: typeof AuthorityPageQuery.Type }) =>
        Effect.gen(function* () {
          const diagnostics = yield* SessionDiagnostics.Service
          const result = yield* diagnostics.listStepUsage({
            sessionID: ctx.params.sessionId,
            cursor: ctx.query.cursor === undefined ? undefined : Number(ctx.query.cursor),
            limit: page(ctx.query),
          })
          return { rows: result.rows, next_cursor: result.nextCursor }
        }),
      )
  }),
)
