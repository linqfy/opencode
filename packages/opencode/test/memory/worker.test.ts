import { beforeEach, describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Event } from "@opencode-ai/schema/event"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import type { MemoryJob } from "@ultracode/events-client"
import { testEffect, pollWithTimeout } from "../lib/effect"
import {
  EXTRACTOR_VERSION,
  TRANSCRIPT_ARTIFACT_ID,
  enqueueForCompaction,
  enqueueForIdle,
  memoryTriggerListener,
  subscribeMemoryTriggers,
} from "../../src/memory/triggers"
import {
  memoryClaimGuard,
  processClaimedJob,
  runMemoryWorker,
  type MemoryWorkerDependencies,
} from "../../src/memory/worker"

const created = DateTime.makeUnsafe(0)

const messages = [
  SessionMessage.User.make({
    id: SessionMessage.ID.make("msg_user"),
    type: "user",
    text: "build a memory tool",
    files: [],
    agents: [],
    time: { created },
  }),
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_assistant"),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content: [SessionMessage.AssistantText.make({ type: "text", id: "text_1", text: "done" })],
    time: { created, completed: created },
  }),
] satisfies SessionMessage.Message[]

const compactionEnded = (sessionID: string, seq: number): EventV2.Payload<typeof SessionEvent.Compaction.Ended> => ({
  id: Event.ID.create(),
  type: SessionEvent.Compaction.Ended.type,
  durable: { aggregateID: sessionID, seq, version: 1 },
  data: {
    sessionID: SessionID.make(sessionID),
    messageID: SessionMessage.ID.make("msg_compaction"),
    timestamp: created,
    reason: "auto",
    text: "summary",
    recent: "recent",
  },
})

const idle = (sessionID: string): EventV2.Payload<typeof SessionStatusEvent.Idle> => ({
  id: Event.ID.create(),
  type: SessionStatusEvent.Idle.type,
  data: { sessionID: SessionID.make(sessionID) },
})

class FakeMemoryClient {
  readonly enqueued: { key: string; kind: unknown }[] = []
  readonly completed: { key: string; kind: unknown }[] = []
  readonly pending: MemoryJob[] = []

  async enqueueMemoryJob(key: string, kind: unknown) {
    this.enqueued.push({ key, kind })
    return { seq: this.enqueued.length, hash: key, duplicate: false }
  }

  async claimMemoryJob(): Promise<MemoryJob | null> {
    const job = this.pending.shift()
    return job ?? null
  }

  async completeMemoryJob(key: string, kind: unknown) {
    this.completed.push({ key, kind })
    return { seq: this.completed.length, hash: key, duplicate: false }
  }
}

const extractionJob = (): MemoryJob => ({
  request_id: "mem:ses_1:42",
  kind: "memory-extraction-requested",
  data: {
    source_session: "ses_1",
    source_turn: 0,
    source_end_seq: 42,
    transcript_artifact_id: TRANSCRIPT_ARTIFACT_ID,
    extractor_version: EXTRACTOR_VERSION,
  },
})

const fakeStore = (): SessionStore.Interface => ({
  get: () => Effect.die("unexpected"),
  context: () => Effect.succeed([...messages]),
  runnerContext: () => Effect.die("unexpected"),
  message: () => Effect.die("unexpected"),
})

describe("memory triggers", () => {
  const it = testEffect(Layer.empty)

  it.effect("enqueues exactly one extraction job for duplicate compaction signals", () =>
    Effect.gen(function* () {
      const fake = new FakeMemoryClient()
      const listener = memoryTriggerListener({ client: fake, claim: memoryClaimGuard() })
      const event = compactionEnded("ses_1", 42)
      yield* listener(event)
      yield* listener(event)
      expect(fake.enqueued).toHaveLength(1)
      expect(fake.enqueued[0]).toEqual({
        key: "mem:ses_1:42",
        kind: {
          kind: "memory-extraction-requested",
          data: {
            request_id: "mem:ses_1:42",
            source_session: "ses_1",
            source_turn: 0,
            source_end_seq: 42,
            transcript_artifact_id: TRANSCRIPT_ARTIFACT_ID,
            extractor_version: EXTRACTOR_VERSION,
          },
        },
      })
    }),
  )

  it.effect("enqueues one stable-key extraction job per idle signal", () =>
    Effect.gen(function* () {
      const fake = new FakeMemoryClient()
      const listener = memoryTriggerListener({ client: fake, claim: memoryClaimGuard() })
      yield* listener(idle("ses_2"))
      yield* listener(idle("ses_2"))
      expect(fake.enqueued).toHaveLength(1)
      expect(fake.enqueued[0]).toEqual({
        key: "mem:ses_2:idle",
        kind: {
          kind: "memory-extraction-requested",
          data: {
            request_id: "mem:ses_2:idle",
            source_session: "ses_2",
            source_turn: 0,
            source_end_seq: 0,
            transcript_artifact_id: TRANSCRIPT_ARTIFACT_ID,
            extractor_version: EXTRACTOR_VERSION,
          },
        },
      })
    }),
  )

  it.effect("ignores unrelated events", () =>
    Effect.gen(function* () {
      const fake = new FakeMemoryClient()
      const listener = memoryTriggerListener({ client: fake, claim: memoryClaimGuard() })
      yield* listener({ id: Event.ID.create(), type: "session.next.step.ended", data: {} })
      expect(fake.enqueued).toHaveLength(0)
    }),
  )

  it.effect("enqueues distinct jobs for compaction and idle signals of the same session", () =>
    Effect.gen(function* () {
      const fake = new FakeMemoryClient()
      const listener = memoryTriggerListener({ client: fake, claim: memoryClaimGuard() })
      yield* listener(compactionEnded("ses_3", 42))
      yield* listener(idle("ses_3"))
      expect(fake.enqueued.map((entry) => entry.key)).toEqual(["mem:ses_3:42", "mem:ses_3:idle"])
    }),
  )
})

describe("memory trigger subscription", () => {
  const listeners: Array<(event: EventV2.Payload) => Effect.Effect<void>> = []
  const it = testEffect(
    Layer.mock(EventV2.Service, {
      listen: (listener) => {
        listeners.push(listener)
        return Effect.succeed(Effect.void)
      },
    }),
  )
  beforeEach(() => {
    listeners.length = 0
  })

  it.effect("subscribes the compaction trigger to EventV2 and dedupes duplicate deliveries", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const fake = new FakeMemoryClient()
      const unsubscribe = yield* subscribeMemoryTriggers({ client: fake, events, claim: memoryClaimGuard() })
      expect(listeners).toHaveLength(1)
      yield* listeners[0]!(compactionEnded("ses_sub", 7))
      yield* listeners[0]!(compactionEnded("ses_sub", 7))
      expect(fake.enqueued).toHaveLength(1)
      yield* unsubscribe
    }),
  )
})

describe("memory worker", () => {
  const it = testEffect(Layer.empty)

  it.effect("completes a claimed extraction job with redacted candidates", () =>
    Effect.gen(function* () {
      const fake = new FakeMemoryClient()
      let received: readonly SessionMessage.Message[] = []
      const deps: MemoryWorkerDependencies = {
        client: fake,
        sessionStore: fakeStore(),
        claim: memoryClaimGuard(),
        now: () => 1_000,
        extract: async (input) => {
          received = input
          return {
            rawMemory: "built a tool; api_key=sk-testsecret1234567890",
            rolloutSummary: "summary sk-testsecret1234567890",
          }
        },
      }
      yield* processClaimedJob(deps, extractionJob())
      expect(received).toEqual(messages)
      expect(fake.completed).toEqual([
        {
          key: "memory:mem:ses_1:42",
          kind: {
            kind: "memory-extracted",
            data: {
              request_id: "mem:ses_1:42",
              thread_id: "memory:mem:ses_1:42",
              source_updated_at: 1_000,
              raw_memory: "built a tool; api_key=[REDACTED]",
              rollout_summary: "summary [REDACTED]",
              rollout_slug: null,
              cwd: "",
              git_branch: null,
              generated_at: 1_000,
            },
          },
        },
      ])
    }),
  )

  it.effect("fails a malformed extraction job closed", () =>
    Effect.gen(function* () {
      const fake = new FakeMemoryClient()
      const deps: MemoryWorkerDependencies = {
        client: fake,
        sessionStore: fakeStore(),
        claim: memoryClaimGuard(),
        now: () => 1_000,
        extract: async () => ({ rawMemory: "raw", rolloutSummary: "summary" }),
      }
      yield* processClaimedJob(deps, { request_id: "mem:bad", kind: "memory-extraction-requested", data: {} })
      expect(fake.completed).toEqual([
        {
          key: "memory-job-failed:mem:bad",
          kind: { kind: "memory-job-failed", data: { request_id: "mem:bad", reason: "invalid memory job" } },
        },
      ])
    }),
  )

  it.live("worker loop claims and completes a queued extraction job", () =>
    Effect.gen(function* () {
      const fake = new FakeMemoryClient()
      fake.pending.push(extractionJob())
      const deps: MemoryWorkerDependencies = {
        client: fake,
        sessionStore: fakeStore(),
        claim: memoryClaimGuard(),
        now: () => 1_000,
        extract: async () => ({ rawMemory: "key=sk-testsecret1234567890", rolloutSummary: "summary" }),
      }
      yield* runMemoryWorker(deps).pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return fake.completed.length > 0 ? (true as const) : undefined
        }),
        "worker never completed the queued extraction job",
      )
      expect(fake.completed[0]?.kind).toEqual({
        kind: "memory-extracted",
        data: expect.objectContaining({ request_id: "mem:ses_1:42", raw_memory: "key=[REDACTED]" }),
      })
    }),
  )
})
