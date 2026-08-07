import { Duration, Effect, Schedule } from "effect"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { redactSecrets } from "@ultracode/memory"
import type { MemoryJob } from "@ultracode/events-client"
import type { MemoryJobClient } from "@/agent/scheduler-service"

export type MemoryClaimGuard = (key: string) => boolean

export const memoryClaimGuard = (): MemoryClaimGuard => {
  const claimed = new Set<string>()
  return (key) => {
    if (claimed.has(key)) return true
    claimed.add(key)
    return false
  }
}

export interface MemoryExtractionCandidate {
  readonly rawMemory: string
  readonly rolloutSummary: string
  readonly rolloutSlug?: string
}

export type MemoryExtractSeam = (
  messages: readonly SessionMessage.Message[],
) => Promise<MemoryExtractionCandidate | undefined>

export interface MemoryWorkerDependencies {
  readonly client: MemoryJobClient
  readonly sessionStore: SessionStore.Interface
  readonly extract: MemoryExtractSeam
  readonly claim: MemoryClaimGuard
  readonly now: () => number
}

type ExtractionRequest = {
  readonly source_session: string
  readonly source_turn: number
  readonly source_end_seq: number
  readonly transcript_artifact_id: string
  readonly extractor_version: string
  readonly cwd?: string
}

export const processClaimedJob = (deps: MemoryWorkerDependencies, job: MemoryJob): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (job.kind !== "memory-extraction-requested") {
      yield* failJob(deps.client, job.request_id, "invalid memory job")
      return
    }
    const request = extractionRequest(job.data)
    if (!request) {
      yield* failJob(deps.client, job.request_id, "invalid memory job")
      return
    }
    yield* runExtraction(deps, request, job.request_id).pipe(
      Effect.catch(() => failJob(deps.client, job.request_id, "memory extraction failed")),
    )
  })

const runExtraction = (
  deps: MemoryWorkerDependencies,
  request: ExtractionRequest,
  requestId: string,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const messages = yield* deps.sessionStore.context(SessionSchema.ID.make(request.source_session)).pipe(
      Effect.mapError(() => new Error("session history unavailable")),
    )
    const candidate = yield* Effect.tryPromise({
      try: () => deps.extract(messages),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
    if (!candidate) return yield* Effect.fail(new Error("extraction returned no candidate"))
    const at = deps.now()
    yield* Effect.tryPromise({
      try: () =>
        deps.client.completeMemoryJob(`memory:${requestId}`, {
          kind: "memory-extracted",
          data: {
            request_id: requestId,
            thread_id: `memory:${requestId}`,
            source_updated_at: at,
            raw_memory: redactSecrets(candidate.rawMemory),
            rollout_summary: redactSecrets(candidate.rolloutSummary),
            rollout_slug: candidate.rolloutSlug !== undefined ? redactSecrets(candidate.rolloutSlug) : null,
            cwd: request.cwd ?? "",
            git_branch: null,
            generated_at: at,
          },
        }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
  })

const pollOnce = (deps: MemoryWorkerDependencies): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const job = yield* Effect.tryPromise({
      try: () => deps.client.claimMemoryJob(),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
    if (!job) return
    if (deps.claim(job.request_id)) return
    yield* processClaimedJob(deps, job)
  })

export const runMemoryWorker = (deps: MemoryWorkerDependencies): Effect.Effect<void> =>
  pollOnce(deps).pipe(
    Effect.catch((error) => Effect.logError("memory worker iteration failed", { cause: error })),
    Effect.repeat(Schedule.spaced(Duration.millis(1_000))),
  )

const extractionRequest = (data: unknown): ExtractionRequest | undefined => {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
  const request = data as Record<string, unknown>
  if (
    typeof request.source_session !== "string" ||
    typeof request.source_turn !== "number" ||
    typeof request.source_end_seq !== "number" ||
    typeof request.transcript_artifact_id !== "string" ||
    typeof request.extractor_version !== "string" ||
    (request.cwd !== undefined && typeof request.cwd !== "string")
  ) {
    return undefined
  }
  return {
    source_session: request.source_session,
    source_turn: request.source_turn,
    source_end_seq: request.source_end_seq,
    transcript_artifact_id: request.transcript_artifact_id,
    extractor_version: request.extractor_version,
    cwd: request.cwd,
  }
}

const failJob = (client: MemoryJobClient, requestId: string, reason: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () =>
      client.completeMemoryJob(`memory-job-failed:${requestId}`, {
        kind: "memory-job-failed",
        data: { request_id: requestId, reason },
      }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.catch(() => Effect.void),
    Effect.asVoid,
  )

export * as MemoryWorker from "./worker"
