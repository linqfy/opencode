import { SchedulerService } from "@/agent/scheduler-service"
import { Config } from "@opencode-ai/core/config"
import { MemoryDisabledError, MemoryNotFoundError } from "@opencode-ai/protocol/errors"
import type { MemoryRecord } from "@ultracode/events-client"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "@opencode-ai/server/api"

const DefaultPageSize = 100
const FetchLimit = 200

const isEnabled = (config: Config.Interface): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const entries = yield* config.entries()
    return entries.some((entry) => entry.type === "document" && entry.info.memory?.enabled === true)
  })

// The sidecar projection returns one bounded page; the handler slices it with
// an opaque offset cursor so continuation requests carry only the cursor.
const page = (records: MemoryRecord[], cursor: string | undefined, limit: number) => {
  const start = cursor === undefined ? 0 : Number(Buffer.from(cursor, "base64url").toString("utf8"))
  const from = Number.isFinite(start) && start >= 0 ? start : 0
  const items = records.slice(from, from + limit)
  const end = from + items.length
  return {
    items,
    next_cursor: end < records.length ? Buffer.from(String(end)).toString("base64url") : null,
  }
}

export const memoryHandlers = HttpApiBuilder.group(Api, "server.memory", (handlers) =>
  Effect.gen(function* () {
    const scheduler = yield* SchedulerService.Service
    const read = yield* scheduler.read.pipe(Effect.orDie)

    return handlers
      .handle("memory.list", (ctx) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          if (!(yield* isEnabled(config))) return yield* new MemoryDisabledError({ message: "Memory is disabled" })
          const records = yield* Effect.promise(() => read.listMemoryRecords({ limit: FetchLimit })).pipe(Effect.orDie)
          return page(records, ctx.query.cursor, ctx.query.limit ?? DefaultPageSize)
        }),
      )
      .handle("memory.get", (ctx) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          if (!(yield* isEnabled(config))) return yield* new MemoryDisabledError({ message: "Memory is disabled" })
          const record = yield* Effect.promise(() => read.getMemoryRecord({ threadId: ctx.params.threadID })).pipe(Effect.orDie)
          if (!record) {
            return yield* new MemoryNotFoundError({
              threadID: ctx.params.threadID,
              message: `Memory record not found: ${ctx.params.threadID}`,
            })
          }
          return record
        }),
      )
      .handle("memory.patch", (ctx) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          if (!(yield* isEnabled(config))) return yield* new MemoryDisabledError({ message: "Memory is disabled" })
          const patch = {
            ...(ctx.payload.raw_memory === undefined ? {} : { rawMemory: ctx.payload.raw_memory }),
            ...(ctx.payload.rollout_summary === undefined ? {} : { rolloutSummary: ctx.payload.rollout_summary }),
            ...(ctx.payload.rollout_slug === undefined ? {} : { rolloutSlug: ctx.payload.rollout_slug }),
          }
          yield* Effect.tryPromise({
            try: () => read.patchMemoryRecord({ threadId: ctx.params.threadID, patch }),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }).pipe(
            Effect.catch((error) =>
              error.message.startsWith("memory record not found")
                ? Effect.fail(
                    new MemoryNotFoundError({
                      threadID: ctx.params.threadID,
                      message: `Memory record not found: ${ctx.params.threadID}`,
                    }),
                  )
                : Effect.die(error),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("memory.delete", (ctx) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          if (!(yield* isEnabled(config))) return yield* new MemoryDisabledError({ message: "Memory is disabled" })
          yield* Effect.tryPromise({
            try: () => read.deleteMemoryRecord({ threadId: ctx.params.threadID }),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }).pipe(
            Effect.catch((error) =>
              error.message.startsWith("memory record not found")
                ? Effect.fail(
                    new MemoryNotFoundError({
                      threadID: ctx.params.threadID,
                      message: `Memory record not found: ${ctx.params.threadID}`,
                    }),
                  )
                : Effect.die(error),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
