import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { InMemoryMemoryStore, type MemoryRecord, type MemoryStore } from "@ultracode/memory"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@opencode-ai/core/config"
import { ConfigMemory } from "@opencode-ai/core/config/memory"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { MemorySource } from "@opencode-ai/core/memory/source"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const now = Date.now()
const DAY = 86_400_000

const record = (threadId: string, over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  threadId,
  sourceUpdatedAt: now,
  rawMemory: "raw",
  rolloutSummary: "",
  cwd: "/repo",
  generatedAt: now,
  usageCount: 0,
  ...over,
})

class ClearableMemoryStore implements MemoryStore {
  private store: InMemoryMemoryStore = new InMemoryMemoryStore()

  async upsert(rec: MemoryRecord): Promise<void> {
    return this.store.upsert(rec)
  }

  async list(): Promise<MemoryRecord[]> {
    return this.store.list()
  }

  async recordUsage(threadIds: readonly string[], atMs: number): Promise<void> {
    return this.store.recordUsage(threadIds, atMs)
  }

  async selectForConsolidation(limit: number): Promise<MemoryRecord[]> {
    return this.store.selectForConsolidation(limit)
  }

  clear(): void {
    this.store = new InMemoryMemoryStore()
  }
}

const directory = AbsolutePath.make("/repo/packages/core")
const projectDirectory = AbsolutePath.make("/repo")
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location(
      { directory },
      { projectDirectory, vcs: { type: "git", store: AbsolutePath.make("/repo/.git") } },
    ),
  ),
)

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({ memory: new ConfigMemory.Info({ enabled: true }) }),
        }),
      ]),
  }),
)

const memoryNode = LayerNode.group([MemorySource.node, SystemContextRegistry.node])

const makeIt = (store: MemoryStore) =>
  testEffect(
    AppNodeBuilder.build(memoryNode, [
      [Location.node, locationLayer],
      [Global.node, Global.layerWith({ config: "/global" })],
      [Config.node, config],
      [
        MemorySource.memoryStoreNode,
        Layer.succeed(MemorySource.MemoryStoreService, MemorySource.MemoryStoreService.of(store)),
      ],
    ]),
  )

describe("MemorySource", () => {
  const store = new ClearableMemoryStore()
  const it = makeIt(store)

  it.effect("renders the memory block on initialize", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => store.upsert(record("t1", { rawMemory: "Title one", sourceUpdatedAt: now - 2 * DAY })))
      yield* Effect.promise(() => store.upsert(record("t2", { rawMemory: "Title two", sourceUpdatedAt: now - DAY })))
      const registry = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* registry.load())

      expect(initialized.baseline).toBe(["## Memory", "- Title two (yesterday)", "- Title one (2 days ago)"].join("\n"))
    }),
  )

  const unchanged = new ClearableMemoryStore()
  const unchangedIt = makeIt(unchanged)

  unchangedIt.effect("reconciles Unchanged when the store is unchanged", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => unchanged.upsert(record("t1", { rawMemory: "Title one" })))
      const registry = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* registry.load())

      const refreshed = yield* SystemContext.reconcile(yield* registry.load(), initialized.snapshot)
      expect(refreshed).toEqual({ _tag: "Unchanged" })
    }),
  )

  const updated = new ClearableMemoryStore()
  const updatedIt = makeIt(updated)

  updatedIt.effect("reconciles Updated with the full new block when the store changes", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => updated.upsert(record("t1", { rawMemory: "Title one" })))
      const registry = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* registry.load())

      yield* Effect.promise(() => updated.upsert(record("t2", { rawMemory: "Title two", sourceUpdatedAt: now - DAY })))
      const refreshed = yield* SystemContext.reconcile(yield* registry.load(), initialized.snapshot)

      expect(refreshed).toMatchObject({
        _tag: "Updated",
        text: ["## Memory", "- Title one (today)", "- Title two (yesterday)"].join("\n"),
      })
    }),
  )

  const capped = new ClearableMemoryStore()
  const cappedIt = makeIt(capped)

  cappedIt.effect("renders the omitted-memories counter when the count cap drops records", () =>
    Effect.gen(function* () {
      for (const index of Array.from({ length: 7 }, (_, index) => index)) {
        yield* Effect.promise(() => capped.upsert(record(`t${index}`, { rawMemory: `Title ${index}` })))
      }
      const registry = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* registry.load())

      expect(initialized.baseline).toBe(
        [
          "## Memory",
          "- Title 0 (today)",
          "- Title 1 (today)",
          "- Title 2 (today)",
          "- Title 3 (today)",
          "- Title 4 (today)",
          "+2 more memories",
        ].join("\n"),
      )
    }),
  )

  const removed = new ClearableMemoryStore()
  const removedIt = makeIt(removed)

  removedIt.effect("renders the removal message when the store empties", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => removed.upsert(record("t1", { rawMemory: "Title one" })))
      const registry = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* registry.load())

      removed.clear()
      const refreshed = yield* SystemContext.reconcile(yield* registry.load(), initialized.snapshot)

      expect(refreshed).toMatchObject({ _tag: "Updated", text: "Previously loaded memory no longer applies." })
    }),
  )
})
