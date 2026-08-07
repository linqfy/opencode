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
    if (deps.claim(key)) return
    yield* enqueueRequested(deps, key, event.data.sessionID, durable.seq)
  })

export const enqueueForIdle = (
  deps: MemoryTriggerSignals,
  event: EventV2.Payload<typeof SessionStatusEvent.Idle>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const key = `mem:${event.data.sessionID}:idle`
    if (deps.claim(key)) return
    yield* enqueueRequested(deps, key, event.data.sessionID, 0)
  })

const enqueueRequested = (
  deps: MemoryTriggerSignals,
  key: string,
  sourceSession: string,
  sourceEndSeq: number,
): Effect.Effect<void> =>
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
    Effect.catch((error) => Effect.logWarning("failed to enqueue memory extraction job", { cause: error })),
    Effect.asVoid,
  )

export * as MemoryTriggers from "./triggers"
