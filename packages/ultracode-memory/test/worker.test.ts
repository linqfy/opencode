import { describe, expect, test } from "bun:test"
import {
  processMemoryJob,
  type DurableMemoryRecord,
  type MemoryJob,
  type MemoryJobClient,
  type MemoryWorkerDependencies,
} from "../src"

const extractionRequest = (overrides: Record<string, unknown> = {}): MemoryJob => ({
  request_id: "req-extract",
  kind: "memory-extraction-requested",
  data: {
    source_session: "ses_1",
    source_turn: 4,
    source_end_seq: 19,
    transcript_artifact_id: "art_1",
    extractor_version: "extractor-v1",
    ...overrides,
  },
})

const record = (thread_id: string, overrides: Partial<DurableMemoryRecord> = {}): DurableMemoryRecord => ({
  thread_id,
  source_updated_at: 100,
  raw_memory: "raw",
  rollout_summary: "summary",
  rollout_slug: null,
  cwd: "/repo",
  git_branch: null,
  generated_at: 101,
  usage_count: 0,
  last_usage: null,
  ...overrides,
})

const client = (job: MemoryJob | null, records: readonly DurableMemoryRecord[] = []) => {
  const commits: { key: string; kind: unknown }[] = []
  const opened: { artifactId: string; sourceSession: string }[] = []
  const value: MemoryJobClient = {
    claimMemoryJob: async () => job,
    listMemoryRecords: async () => records,
    proposeCommit: async (key, kind) => void commits.push({ key, kind }),
    openTranscript: async (artifactId, sourceSession) => {
      opened.push({ artifactId, sourceSession })
      return "immutable transcript"
    },
  }
  return { client: value, commits, opened }
}

const dependencies = (
  client: MemoryJobClient,
  overrides: Partial<Omit<MemoryWorkerDependencies, "client">> = {},
): MemoryWorkerDependencies => ({
  client,
  extract: async () => JSON.stringify({ raw_memory: "raw output", rollout_summary: "summary output", rollout_slug: "slug" }),
  consolidate: async () => JSON.stringify({ summary: "combined", memory: "combined memory", source_thread_ids: ["thread-a"] }),
  now: () => 500,
  ...overrides,
})

describe("processMemoryJob", () => {
  test("returns false when no memory job is available", async () => {
    const fake = client(null)

    expect(await processMemoryJob(dependencies(fake.client))).toBe(false)
    expect(fake.commits).toEqual([])
  })

  test("extracts an immutable transcript and commits the exact extracted event", async () => {
    const fake = client(extractionRequest({ cwd: "/workspace" }))

    expect(await processMemoryJob(dependencies(fake.client))).toBe(true)
    expect(fake.opened).toEqual([{ artifactId: "art_1", sourceSession: "ses_1" }])
    expect(fake.commits).toEqual([
      {
        key: "memory-extracted:req-extract",
        kind: {
          kind: "memory-extracted",
          data: {
            request_id: "req-extract",
            thread_id: "memory:req-extract",
            source_updated_at: 500,
            raw_memory: "raw output",
            rollout_summary: "summary output",
            rollout_slug: "slug",
            cwd: "/workspace",
            git_branch: null,
            generated_at: 500,
          },
        },
      },
    ])
  })

  test("fails an invalid extraction request without committing", async () => {
    const fake = client(extractionRequest({ source_turn: "four" }))

    expect(await processMemoryJob(dependencies(fake.client))).toBe(true)
    expect(fake.commits).toEqual([{ key: "memory-job-failed:req-extract", kind: { kind: "memory-job-failed", data: { request_id: "req-extract", reason: "invalid memory job" } } }])
  })

  test("fails a model extraction error without committing", async () => {
    const fake = client(extractionRequest())

    expect(
      await processMemoryJob(
        dependencies(fake.client, {
          extract: async () => {
            throw new Error("model credential secret")
          },
        }),
      ),
    ).toBe(true)
    expect(fake.commits).toEqual([{ key: "memory-job-failed:req-extract", kind: { kind: "memory-job-failed", data: { request_id: "req-extract", reason: "memory extraction failed" } } }])
  })

  test("consolidates only requested durable records and preserves source provenance", async () => {
    const records = [record("thread-a"), record("excluded"), record("thread-b", { usage_count: 3 })]
    const originalRecords = structuredClone(records)
    const job: MemoryJob = {
      request_id: "req-consolidate",
      kind: "memory-consolidation-requested",
      data: { record_thread_ids: ["thread-a", "thread-b"], consolidator_version: "consolidator-v1" },
    }
    const fake = client(job, records)
    let received: readonly { threadId: string }[] = []

    expect(
      await processMemoryJob(
        dependencies(fake.client, {
          consolidate: async (input) => {
            received = input
            return JSON.stringify({ summary: "combined", memory: "combined memory", source_thread_ids: ["thread-b"] })
          },
        }),
      ),
    ).toBe(true)
    expect(received.map((item) => item.threadId)).toEqual(["thread-b", "thread-a"])
    expect(fake.commits).toEqual([
      {
        key: "memory-consolidated:req-consolidate",
        kind: {
          kind: "memory-consolidated",
          data: {
            request_id: "req-consolidate",
            memory_id: "memory:req-consolidate",
            summary: "combined",
            memory: "combined memory",
            source_thread_ids: ["thread-b"],
            generated_at: 500,
          },
        },
      },
    ])
    expect(records).toEqual(originalRecords)
  })

  test("fails malformed and unknown jobs closed", async () => {
    const malformed = client({ request_id: "req-malformed", kind: "memory-consolidation-requested", data: {} })
    const unknown = client({ request_id: "req-unknown", kind: "unrecognized", data: {} })

    expect(await processMemoryJob(dependencies(malformed.client))).toBe(true)
    expect(await processMemoryJob(dependencies(unknown.client))).toBe(true)
    expect(malformed.commits).toEqual([{ key: "memory-job-failed:req-malformed", kind: { kind: "memory-job-failed", data: { request_id: "req-malformed", reason: "invalid memory job" } } }])
    expect(unknown.commits).toEqual([{ key: "memory-job-failed:req-unknown", kind: { kind: "memory-job-failed", data: { request_id: "req-unknown", reason: "invalid memory job" } } }])
  })

  test("fails closed when a sidecar operation rejects", async () => {
    const fake = client(extractionRequest())
    const failingClient: MemoryJobClient = {
      ...fake.client,
      openTranscript: async () => {
        throw new Error("sidecar token exposed")
      },
    }

    expect(await processMemoryJob(dependencies(failingClient))).toBe(true)
    expect(fake.commits).toEqual([{ key: "memory-job-failed:req-extract", kind: { kind: "memory-job-failed", data: { request_id: "req-extract", reason: "memory extraction failed" } } }])
  })
})
