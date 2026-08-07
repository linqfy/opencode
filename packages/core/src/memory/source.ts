export * as MemorySource from "./source"

import { createHash } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { InMemoryMemoryStore, memoryAge, rankForConsolidation, type MemoryRecord, type MemoryStore } from "@ultracode/memory"
import { makeLocationNode } from "../effect/app-node"
import { Config } from "../config"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { InstructionContext } from "../instruction-context"
import { Location } from "../location"
import { SystemContext } from "../system-context"
import { SystemContextRegistry } from "../system-context/registry"
import {
  MAX_MEMORY_BYTES_PER_RECORD,
  MAX_MEMORY_RECORDS,
  MAX_MEMORY_TOTAL_BYTES,
  selectForInjection,
} from "./select"

const key = SystemContext.Key.make("core/memory")

const MemoryEntry = Schema.Struct({
  key: Schema.String,
  hash: Schema.String,
  updatedAt: Schema.Number,
  title: Schema.String,
})

const MemoryValue = Schema.Struct({
  records: Schema.Array(MemoryEntry),
  omitted: Schema.Number,
})
type MemoryValue = Schema.Schema.Type<typeof MemoryValue>

const codec = Schema.toCodecJson(MemoryValue)

const MAX_RENDER_BYTES = 4096
const BLOCK_TRUNCATION_MARKER = "\n[memory block truncated]"

const renderBlock = (value: MemoryValue): string => {
  const lines = value.records.map((entry) => `- ${entry.title} (${memoryAge(entry.updatedAt)})`)
  if (value.omitted > 0) lines.push(`+${value.omitted} more memories`)
  return capBlock(["## Memory", ...lines].join("\n"))
}

const capBlock = (block: string): string => {
  if (byteLength(block) <= MAX_RENDER_BYTES) return block
  const budget = MAX_RENDER_BYTES - byteLength(BLOCK_TRUNCATION_MARKER)
  return `${truncateToBytes(block, budget)}${BLOCK_TRUNCATION_MARKER}`
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length

const decoder = new TextDecoder()

const truncateToBytes = (text: string, budget: number): string => {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= budget) return text
  return decoder.decode(bytes.subarray(0, budget)).replace(/\uFFFD$/u, "")
}

export const observe = (store: MemoryStore) =>
  Effect.gen(function* () {
    const all = yield* Effect.promise(() => store.list())
    if (all.length === 0) return SystemContext.empty
    const ranked = rankForConsolidation(all)
    const selection = selectForInjection(ranked, {
      maxRecords: MAX_MEMORY_RECORDS,
      maxBytesPerRecord: MAX_MEMORY_BYTES_PER_RECORD,
      maxTotalBytes: MAX_MEMORY_TOTAL_BYTES,
      now: Date.now(),
    })
    const value: MemoryValue = {
      records: selection.records.map(toEntry),
      omitted: selection.omitted,
    }
    return SystemContext.make({
      key,
      codec,
      load: Effect.succeed(value),
      baseline: renderBlock,
      update: (_previous, current) => renderBlock(current),
      removed: () => "Previously loaded memory no longer applies.",
    })
  })

const toEntry = (record: MemoryRecord): Schema.Schema.Type<typeof MemoryEntry> => ({
  key: record.threadId,
  hash: hashOf(`${record.rawMemory}\n${record.rolloutSummary}`),
  updatedAt: record.lastUsage ?? record.sourceUpdatedAt,
  title: titleOf(record),
})

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex")

const titleOf = (record: MemoryRecord): string => {
  const raw = firstLine(record.rawMemory)
  if (raw) return raw
  const summary = firstLine(record.rolloutSummary)
  if (summary) return summary
  return record.threadId
}

const firstLine = (text: string): string | undefined => {
  const line = text.split("\n")[0]
  return line ? line.trim() : undefined
}

export class MemoryStoreService extends Context.Service<MemoryStoreService, MemoryStore>()("@opencode/v2/MemoryStore") {}

const storeLayer = Layer.succeed(MemoryStoreService, MemoryStoreService.of(new InMemoryMemoryStore()))

export const memoryStoreNode = makeLocationNode({ service: MemoryStoreService, layer: storeLayer, deps: [] })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* SystemContextRegistry.Service
    const config = yield* Config.Service
    const memoryEnabled = Config.latest(yield* config.entries(), "memory")?.enabled === true
    if (!memoryEnabled) return
    // Gate before touching the store so a disabled location never builds a
    // sidecar-backed store (or any store) at all.
    const store = yield* MemoryStoreService
    yield* registry.register({ key, load: observe(store) })
  }),
)

export const node = makeLocationNode({
  name: "system-context-memory",
  layer,
  deps: [
    memoryStoreNode,
    Config.node,
    Location.node,
    SystemContextRegistry.node,
    InstructionContext.node,
    FSUtil.node,
    Global.node,
  ],
})
