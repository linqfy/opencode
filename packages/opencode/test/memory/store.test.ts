import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { MemorySource } from "@opencode-ai/core/memory/source"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SidecarMemoryStore } from "@/memory/service"
import type { MemoryRecordsReader } from "@/memory/service"
import { testEffect } from "../lib/effect"

interface FakeRecord {
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
  readonly deleted_at: number | null
}

const makeRecord = (threadId: string, over: Partial<FakeRecord> = {}): FakeRecord => ({
  thread_id: threadId,
  source_updated_at: 1_000,
  raw_memory: `Title ${threadId}`,
  rollout_summary: "",
  rollout_slug: null,
  cwd: "/repo",
  git_branch: null,
  generated_at: 1_000,
  usage_count: 0,
  last_usage: null,
  deleted_at: null,
  ...over,
})

const readerOver = (records: () => readonly FakeRecord[]): MemoryRecordsReader => ({
  listMemoryRecords: async () => records(),
})

const it = testEffect(Layer.empty)

describe("sidecar-backed memory store", () => {
  it.effect("surfaces sidecar records into the memory block", () =>
    Effect.gen(function* () {
      const store = new SidecarMemoryStore(() => readerOver(() => [makeRecord("one"), makeRecord("two")]))
      const initialized = yield* SystemContext.initialize(yield* MemorySource.observe(store))
      expect(initialized.baseline).toContain("## Memory")
      expect(initialized.baseline).toContain("- Title one")
      expect(initialized.baseline).toContain("- Title two")
    }),
  )

  it.effect("omits a deleted record from the rendered block", () =>
    Effect.gen(function* () {
      const records = [makeRecord("one"), makeRecord("two"), makeRecord("gone", { deleted_at: 9_999 })]
      const store = new SidecarMemoryStore(() => readerOver(() => records))
      const initialized = yield* SystemContext.initialize(yield* MemorySource.observe(store))
      expect(initialized.baseline).toContain("- Title one")
      expect(initialized.baseline).toContain("- Title two")
      expect(initialized.baseline).not.toContain("- Title gone")
    }),
  )

  it.effect("renders an empty block when the reader is unavailable", () =>
    Effect.gen(function* () {
      const store = new SidecarMemoryStore(() => undefined)
      const initialized = yield* SystemContext.initialize(yield* MemorySource.observe(store))
      expect(initialized.baseline).not.toContain("## Memory")
    }),
  )

  it.effect("renders an empty block when the sidecar request fails", () =>
    Effect.gen(function* () {
      const store = new SidecarMemoryStore(() => ({
        listMemoryRecords: async () => {
          throw new Error("sidecar unavailable")
        },
      }))
      const initialized = yield* SystemContext.initialize(yield* MemorySource.observe(store))
      expect(initialized.baseline).not.toContain("## Memory")
    }),
  )
})
