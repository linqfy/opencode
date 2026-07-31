import { consolidateMemory, type MemoryConsolidator } from "./consolidate"
import { extractMemory, type MemoryExtractor } from "./extract"
import type { MemoryRecord } from "./record"

export interface DurableMemoryRecord {
  readonly thread_id: string
  readonly source_updated_at: number
  readonly raw_memory: string
  readonly rollout_summary: string
  readonly rollout_slug: string | null
  readonly cwd: string
  readonly git_branch: string | null
  readonly generated_at: number
  readonly usage_count: number
  readonly last_usage: number | null
}

export interface MemoryJob {
  readonly request_id: string
  readonly kind: string
  readonly data: unknown
}

export interface MemoryJobClient {
  readonly claimMemoryJob: () => Promise<MemoryJob | null>
  readonly listMemoryRecords: (limit?: number) => Promise<readonly DurableMemoryRecord[]>
  readonly proposeCommit: (key: string, kind: { readonly kind: string; readonly data: unknown }) => Promise<void>
  readonly openTranscript: (artifactId: string, sourceSession: string) => Promise<string>
}

export interface MemoryWorkerDependencies {
  readonly client: MemoryJobClient
  readonly extract: MemoryExtractor
  readonly consolidate: MemoryConsolidator
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

type ConsolidationRequest = {
  readonly record_thread_ids: readonly string[]
  readonly consolidator_version: string
}

export const processMemoryJob = async (dependencies: MemoryWorkerDependencies): Promise<boolean> => {
  let job: MemoryJob | null
  try {
    job = await dependencies.client.claimMemoryJob()
  } catch {
    return false
  }
  if (!job) return false

  if (job.kind === "memory-extraction-requested") {
    const request = extractionRequest(job.data)
    if (!request) {
      await fail(dependencies.client, job.request_id, "invalid memory job")
      return true
    }
    try {
      const extraction = await extractMemory(
        await dependencies.client.openTranscript(request.transcript_artifact_id, request.source_session),
        dependencies.extract,
      )
      if (!extraction) {
        await fail(dependencies.client, job.request_id, "memory extraction failed")
        return true
      }
      const generatedAt = dependencies.now()
      await dependencies.client.proposeCommit(`memory-extracted:${job.request_id}`, {
        kind: "memory-extracted",
        data: {
          request_id: job.request_id,
          thread_id: `memory:${job.request_id}`,
          source_updated_at: generatedAt,
          raw_memory: extraction.rawMemory,
          rollout_summary: extraction.rolloutSummary,
          rollout_slug: extraction.rolloutSlug ?? null,
          cwd: request.cwd ?? "",
          git_branch: null,
          generated_at: generatedAt,
        },
      })
      return true
    } catch {
      await fail(dependencies.client, job.request_id, "memory extraction failed")
      return true
    }
  }

  if (job.kind === "memory-consolidation-requested") {
    const request = consolidationRequest(job.data)
    if (!request) {
      await fail(dependencies.client, job.request_id, "invalid memory job")
      return true
    }
    try {
      const requested = new Set(request.record_thread_ids)
      const records: MemoryRecord[] = (await dependencies.client.listMemoryRecords())
        .filter((record) => requested.has(record.thread_id))
        .map((record) => ({
          threadId: record.thread_id,
          sourceUpdatedAt: record.source_updated_at,
          rawMemory: record.raw_memory,
          rolloutSummary: record.rollout_summary,
          rolloutSlug: record.rollout_slug ?? undefined,
          cwd: record.cwd,
          gitBranch: record.git_branch ?? undefined,
          generatedAt: record.generated_at,
          usageCount: record.usage_count,
          lastUsage: record.last_usage ?? undefined,
        }))
      const consolidation = await consolidateMemory(records, dependencies.consolidate)
      if (!consolidation) {
        await fail(dependencies.client, job.request_id, "memory consolidation failed")
        return true
      }
      await dependencies.client.proposeCommit(`memory-consolidated:${job.request_id}`, {
        kind: "memory-consolidated",
        data: {
          request_id: job.request_id,
          memory_id: `memory:${job.request_id}`,
          summary: consolidation.summary,
          memory: consolidation.memory,
          source_thread_ids: consolidation.sourceThreadIds,
          generated_at: dependencies.now(),
        },
      })
      return true
    } catch {
      await fail(dependencies.client, job.request_id, "memory consolidation failed")
      return true
    }
  }

  await fail(dependencies.client, job.request_id, "invalid memory job")
  return true
}

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

const consolidationRequest = (data: unknown): ConsolidationRequest | undefined => {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
  const request = data as Record<string, unknown>
  if (
    !Array.isArray(request.record_thread_ids) ||
    !request.record_thread_ids.every((threadId) => typeof threadId === "string") ||
    typeof request.consolidator_version !== "string"
  ) {
    return undefined
  }
  return { record_thread_ids: request.record_thread_ids, consolidator_version: request.consolidator_version }
}

const fail = async (client: MemoryJobClient, requestId: string, reason: string): Promise<void> => {
  try {
    await client.proposeCommit(`memory-job-failed:${requestId}`, {
      kind: "memory-job-failed",
      data: { request_id: requestId, reason },
    })
  } catch {}
}
