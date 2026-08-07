import { Effect } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import type { MemoryJobClient } from "@/agent/scheduler-service"
import type { MemoryClaimGuard } from "./worker"

export const EXTRACTOR_VERSION = "extractor-v1"
export const TRANSCRIPT_ARTIFACT_ID = "memory-transcript-pending"

export interface MemoryTriggerSignals {
  readonly client: MemoryJobClient
  readonly claim: MemoryClaimGuard
}

export interface MemoryTriggerDependencies extends MemoryTriggerSignals {
  readonly events: EventV2.Interface
}

export const memoryTriggerListener =
  (deps: MemoryTriggerSignals) =>
  (event: EventV2.Payload): Effect.Effect<void> => {
    if (event.type === SessionEvent.Compaction.Ended.type) {
      return enqueueForCompaction(deps, event as EventV2.Payload<typeof SessionEvent.Compaction.Ended>)
    }
    if (event.type === SessionStatusEvent.Idle.type) {
      return enqueueForIdle(deps, event as EventV2.Payload<typeof SessionStatusEvent.Idle>)
    }
    return Effect.void
  }

export const subscribeMemoryTriggers = (deps: MemoryTriggerDependencies): Effect.Effect<EventV2.Unsubscribe> =>
  deps.events.listen(memoryTriggerListener(deps))

export const enqueueForCompaction = (
  deps: MemoryTriggerSignals,
  event: EventV2.Payload<typeof SessionEvent.Compaction.Ended>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const durable = event.durable
    if (!durable) return
    const key = `mem:${event.data.sessionID}:${durable.seq}`
    if (deps.claim.claimed(key)) return
    const enqueued = yield* enqueueRequested(deps, key, event.data.sessionID, durable.seq)
    if (enqueued) deps.claim.mark(key)
  })

export const enqueueForIdle = (
  deps: MemoryTriggerSignals,
  event: EventV2.Payload<typeof SessionStatusEvent.Idle>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // The event id varies per emission so a session that idles repeatedly gets
    // a fresh extraction key each time; replaying the same event dedupes.
    const key = `mem:${event.data.sessionID}:idle:${event.id}`
    if (deps.claim.claimed(key)) return
    const enqueued = yield* enqueueRequested(deps, key, event.data.sessionID, 0)
    if (enqueued) deps.claim.mark(key)
  })

const enqueueRequested = (
  deps: MemoryTriggerSignals,
  key: string,
  sourceSession: string,
  sourceEndSeq: number,
): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: () =>
      deps.client.enqueueMemoryJob(key, {
        kind: "memory-extraction-requested",
        data: {
          request_id: key,
          source_session: sourceSession,
          // No turn counter rides the compaction/idle events; the worker reads
          // the session's current history via SessionStore, so provenance is advisory.
          source_turn: 0,
          source_end_seq: sourceEndSeq,
          transcript_artifact_id: TRANSCRIPT_ARTIFACT_ID,
          extractor_version: EXTRACTOR_VERSION,
        },
      }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => Effect.logWarning("failed to enqueue memory extraction job", { cause: error }).pipe(Effect.as(false)),
      onSuccess: () => Effect.succeed(true),
    }),
  )

export * as MemoryTriggers from "./triggers"
