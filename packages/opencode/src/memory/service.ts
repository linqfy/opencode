import { Context, Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionStore } from "@opencode-ai/core/session/store"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode, makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { MemoryStoreService } from "@opencode-ai/core/memory/source"
import { rankForConsolidation } from "@ultracode/memory"
import type { MemoryRecord, MemoryStore } from "@ultracode/memory"
import { SchedulerService } from "@/agent/scheduler-service"
import { subscribeMemoryTriggers } from "./triggers"
import { memoryClaimGuard, runMemoryWorker, type MemoryExtractSeam } from "./worker"

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryService") {}

export const layerWith = (input: { readonly extract: MemoryExtractSeam }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const scheduler = yield* SchedulerService.Service
      const sessionStore = yield* SessionStore.Service
      const events = yield* EventV2.Service
      const config = yield* Config.Service
      const memoryEnabled = Config.latest(yield* config.entries(), "memory")?.enabled === true
      if (!memoryEnabled) {
        yield* Effect.logInfo("memory extraction disabled: memory.enabled is not set")
        return Service.of({})
      }
      const client = yield* scheduler.events.pipe(
        Effect.match({
          onFailure: () => null,
          onSuccess: (value) => value,
        }),
      )
      if (client === null) {
        yield* Effect.logInfo("memory extraction disabled: scheduler sidecar unavailable")
        return Service.of({})
      }
      // The location-scoped MemoryStoreService reads the same durable projection
      // through this client's read API, so the core/memory block reflects the
      // sidecar's records (including deletes) without a per-location store.
      const read = yield* scheduler.read.pipe(
        Effect.match({
          onFailure: () => null,
          onSuccess: (value) => value,
        }),
      )
      if (read !== null) sharedMemoryReader.current = read
      const unsubscribe = yield* subscribeMemoryTriggers({ client, events, claim: memoryClaimGuard() })
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* runMemoryWorker({
        client,
        sessionStore,
        extract: input.extract,
        claim: memoryClaimGuard(),
        now: () => Date.now(),
      }).pipe(Effect.forkScoped)
      return Service.of({})
    }),
  )

// Config.Service is location-scoped; the global worker reads the config of the
// process's working directory, so bind it into the app graph through the
// LocationServiceMap instead of a raw location node.
const defaultConfig = Layer.unwrap(
  Effect.map(LocationServiceMap.Service, (map) => map.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }))),
)
const defaultConfigNode = makeGlobalNode({
  service: Config.Service,
  layer: defaultConfig,
  deps: [LocationServiceMap.node],
})

// Production wiring uses a fails-closed extractor until an LLM-backed seam is
// available; claimed jobs fail without writing candidate records.
export const node = LayerNode.make({
  service: Service,
  layer: layerWith({ extract: async () => undefined }).pipe(Layer.orDie),
  deps: [defaultConfigNode, SchedulerService.node, SessionStore.node, EventV2.node],
})

// The sidecar projection's list response shape, narrowed to the fields the
// context source consumes (the reader is the SchedulerService read API).
interface SidecarMemoryRecord {
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

export interface MemoryRecordsReader {
  readonly listMemoryRecords: (input: { limit?: number }) => Promise<readonly SidecarMemoryRecord[]>
}

const ListLimit = 200

// Published by the MemoryService layer once it has a live sidecar read API;
// location-scoped stores read through it so every location shares one client.
const sharedMemoryReader: { current: MemoryRecordsReader | undefined } = { current: undefined }

const toMemoryRecord = (record: SidecarMemoryRecord): MemoryRecord | undefined => {
  if (record.deleted_at !== null) return undefined
  return {
    threadId: record.thread_id,
    sourceUpdatedAt: record.source_updated_at,
    rawMemory: record.raw_memory,
    rolloutSummary: record.rollout_summary,
    ...(record.rollout_slug === null ? {} : { rolloutSlug: record.rollout_slug }),
    cwd: record.cwd,
    ...(record.git_branch === null ? {} : { gitBranch: record.git_branch }),
    generatedAt: record.generated_at,
    usageCount: record.usage_count,
    ...(record.last_usage === null ? {} : { lastUsage: record.last_usage }),
  }
}

export class SidecarMemoryStore implements MemoryStore {
  constructor(private readonly reader: () => MemoryRecordsReader | undefined) {}

  // The durable write path is the worker's completeMemoryJob; the context
  // source's store is a read projection only.
  async upsert(): Promise<void> {}

  async list(): Promise<MemoryRecord[]> {
    const reader = this.reader()
    if (!reader) return []
    const records = await reader.listMemoryRecords({ limit: ListLimit }).catch(() => [])
    return records.flatMap((record) => toMemoryRecord(record) ?? [])
  }

  async recordUsage(): Promise<void> {}

  async selectForConsolidation(limit: number): Promise<MemoryRecord[]> {
    return rankForConsolidation(await this.list()).slice(0, limit)
  }
}

const sidecarStoreLayer = Layer.succeed(
  MemoryStoreService,
  MemoryStoreService.of(new SidecarMemoryStore(() => sharedMemoryReader.current)),
)

// Replaces the in-memory MemoryStoreService in the location service graph so
// the core/memory source renders the sidecar's durable projection.
export const sidecarMemoryStoreNode = makeLocationNode({
  service: MemoryStoreService,
  layer: sidecarStoreLayer,
  deps: [],
})

export * as MemoryService from "./service"
