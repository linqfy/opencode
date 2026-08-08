export * as SessionDiagnostics from "./diagnostics"

import { and, desc, eq, lt } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { StepUsageTable } from "./sql"

export const cacheHitRate = (usage: { readonly input: number; readonly cacheRead: number }) => {
  const total = usage.input + usage.cacheRead
  return total === 0 ? 0 : usage.cacheRead / total
}

export interface StepUsageRow {
  readonly id: number
  readonly sessionID: string
  readonly assistantMessageID: string
  readonly providerID: string
  readonly modelID: string
  readonly profileID: string
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cacheHitRate: number
  readonly createdAt: number
}

const row = (value: (typeof StepUsageTable)["$inferSelect"]): StepUsageRow => ({
  id: value.id,
  sessionID: value.session_id,
  assistantMessageID: value.assistant_message_id,
  providerID: value.provider_id,
  modelID: value.model_id,
  profileID: value.profile_id,
  input: value.input_tokens,
  output: value.output_tokens,
  reasoning: value.reasoning_tokens,
  cacheRead: value.cache_read_tokens,
  cacheWrite: value.cache_write_tokens,
  cacheHitRate: value.cache_hit_rate,
  createdAt: value.time_created,
})

export interface Interface {
  readonly record: (input: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly providerID: string
    readonly modelID: string
    readonly profileID: string
    readonly usage: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cache: { readonly read: number; readonly write: number } }
  }) => Effect.Effect<void>
  readonly listStepUsage: (input: { readonly sessionID: string; readonly cursor?: number; readonly limit?: number }) => Effect.Effect<{ rows: StepUsageRow[]; nextCursor: number | null }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionDiagnostics") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return Service.of({
      record: (input) =>
        db
          .insert(StepUsageTable)
          .values({
            session_id: SessionSchema.ID.make(input.sessionID),
            assistant_message_id: SessionMessage.ID.make(input.assistantMessageID),
            provider_id: input.providerID,
            model_id: input.modelID,
            profile_id: input.profileID,
            input_tokens: input.usage.input,
            output_tokens: input.usage.output,
            reasoning_tokens: input.usage.reasoning,
            cache_read_tokens: input.usage.cache.read,
            cache_write_tokens: input.usage.cache.write,
            cache_hit_rate: cacheHitRate({ input: input.usage.input, cacheRead: input.usage.cache.read }),
          })
          .run()
          .pipe(
            Effect.asVoid,
            Effect.catch((error) => Effect.logError("Failed to persist step usage", { error })),
          ),
      listStepUsage: (input) =>
        Effect.gen(function* () {
          const limit = Math.min(200, Math.max(1, input.limit ?? 100))
          // Fetch limit + 1 to learn whether another page exists.
          const values = yield* db
            .select()
            .from(StepUsageTable)
            .where(
              and(
                eq(StepUsageTable.session_id, SessionSchema.ID.make(input.sessionID)),
                input.cursor === undefined ? undefined : lt(StepUsageTable.id, input.cursor),
              ),
            )
            .orderBy(desc(StepUsageTable.id))
            .limit(limit + 1)
            .all()
            .pipe(Effect.orDie)
          const hasMore = values.length > limit
          const rows = values.slice(0, limit).map(row)
          const nextCursor = hasMore ? rows[rows.length - 1]?.id ?? null : null
          return { rows, nextCursor }
        }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
