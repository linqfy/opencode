import { describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { SchedulerService, SchedulerUnavailableError, createReadApi } from "@/agent/scheduler-service"
import { MemoryService } from "@/memory/service"
import type { MemoryRecord } from "@ultracode/events-client"
import { createRoutes } from "../../src/server/routes/instance/httpapi/server"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { requestInDirectory } from "./httpapi-layer"

// The real memory review handler reads the sidecar projection through the
// SchedulerService read API. Each test swaps in a fake client over an
// in-memory record array, mirroring the sidecar's journal-backed semantics.
let store: MemoryRecord[] = []

const makeRecord = (threadId: string, rawMemory = "raw", rolloutSummary = "summary"): MemoryRecord => ({
  thread_id: threadId,
  source_session: "ses_1",
  source_turn: 1,
  source_end_seq: 1,
  transcript_artifact_id: "art-a",
  extractor_version: "v1",
  source_updated_at: 1,
  raw_memory: rawMemory,
  rollout_summary: rolloutSummary,
  rollout_slug: null,
  cwd: "/repo",
  git_branch: null,
  generated_at: 2,
  usage_count: 0,
  last_usage: null,
  deleted_at: null,
  edited_by: null,
  edited_at: null,
})

const live = () => store.filter((record) => record.deleted_at === null)

const fakeClient = {
  listMemoryRecords: async (limit = 200) =>
    live()
      .sort((a, b) => (a.usage_count === b.usage_count ? a.thread_id.localeCompare(b.thread_id) : b.usage_count - a.usage_count))
      .slice(0, limit),
  getMemoryRecord: async (threadId: string) => live().find((record) => record.thread_id === threadId) ?? null,
  deleteMemoryRecord: async (threadId: string) => {
    const record = live().find((record) => record.thread_id === threadId)
    if (!record) throw new Error(`memory record not found: ${threadId}`)
    record.deleted_at = Date.now()
    return { seq: 1, hash: "h", duplicate: false }
  },
  patchMemoryRecord: async (threadId: string, patch: { rawMemory?: string; rolloutSummary?: string; rolloutSlug?: string }) => {
    const record = live().find((record) => record.thread_id === threadId)
    if (!record) throw new Error(`memory record not found: ${threadId}`)
    if (patch.rawMemory !== undefined) record.raw_memory = patch.rawMemory
    if (patch.rolloutSummary !== undefined) record.rollout_summary = patch.rolloutSummary
    if (patch.rolloutSlug !== undefined) record.rollout_slug = patch.rolloutSlug
    record.edited_by = "user"
    record.edited_at = Date.now()
    return { seq: 1, hash: "h", duplicate: false }
  },
  // Read API methods the memory handler never calls; stubs keep the type honest.
  queryTaskGraph: async () => ({ tasks: [], edges: [], next_cursor: null }),
  listApprovalHistory: async () => ({ items: [], next_cursor: null }),
  queryTaskDeliverables: async () => ({ items: [], next_cursor: null }),
  replay: async () => [],
  statArtifact: async () => null,
  openRange: async () => new Uint8Array(),
  cancelTask: async () => ({ state: "cancellation_pending" as const }),
}

const schedulerLayer = Layer.succeed(
  SchedulerService.Service,
  SchedulerService.Service.of({
    adapter: Effect.fail(new SchedulerUnavailableError("memory test")),
    read: Effect.succeed(createReadApi(fakeClient, undefined)),
    events: Effect.fail(new SchedulerUnavailableError("memory test")),
  }),
)

const memoryLayer = Layer.succeed(MemoryService.Service, MemoryService.Service.of({}))

const routes = createRoutes(undefined, [
  [SchedulerService.node, schedulerLayer],
  [MemoryService.node, memoryLayer],
])

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(routes, {
  disableListenLog: true,
  disableLogger: true,
})

const it = testEffect(
  servedRoutes.pipe(
    Layer.provide(layerWebSocketConstructorGlobal),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  ),
)

// Written without any V1 config keys so the V2 loader treats it as V2 config
// and preserves the memory field.
const enabledConfig = { memory: { enabled: true } } as never

describe("memory HttpApi", () => {
  it.live("lists memory records with an opaque cursor", () =>
    Effect.gen(function* () {
      store = [makeRecord("thread-a", "a"), makeRecord("thread-b", "b"), makeRecord("thread-c", "c")]
      const directory = yield* tmpdirScoped({ git: true, config: enabledConfig })

      const first = yield* requestInDirectory("/api/memory?limit=2", directory)
      expect(first.status).toBe(200)
      const firstBody = (yield* first.json) as { items: { thread_id: string }[]; next_cursor: string | null }
      expect(firstBody.items.map((item) => item.thread_id)).toEqual(["thread-a", "thread-b"])
      expect(typeof firstBody.next_cursor).toBe("string")

      const second = yield* requestInDirectory(`/api/memory?cursor=${encodeURIComponent(firstBody.next_cursor as string)}`, directory)
      expect(second.status).toBe(200)
      const secondBody = (yield* second.json) as { items: { thread_id: string }[]; next_cursor: string | null }
      expect(secondBody.items.map((item) => item.thread_id)).toEqual(["thread-c"])
      expect(secondBody.next_cursor).toBeNull()
    }),
  )

  it.live("gets a single memory record by thread id", () =>
    Effect.gen(function* () {
      store = [makeRecord("thread-a", "raw-a")]
      const directory = yield* tmpdirScoped({ git: true, config: enabledConfig })

      const response = yield* requestInDirectory("/api/memory/thread-a", directory)
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ thread_id: "thread-a", raw_memory: "raw-a" })

      const missing = yield* requestInDirectory("/api/memory/thread-missing", directory)
      expect(missing.status).toBe(404)
      expect(((yield* missing.json) as { _tag: string })._tag).toBe("MemoryNotFoundError")
    }),
  )

  it.live("patch persists edited_by user and a timestamp", () =>
    Effect.gen(function* () {
      store = [makeRecord("thread-a", "raw-a")]
      const directory = yield* tmpdirScoped({ git: true, config: enabledConfig })

      const patched = yield* requestInDirectory("/api/memory/thread-a", directory, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw_memory: "edited" }),
      })
      expect(patched.status).toBe(204)

      const record = (yield* requestInDirectory("/api/memory/thread-a", directory).pipe(Effect.flatMap((response) => response.json))) as {
        raw_memory: string
        edited_by: string
        edited_at: number
      }
      expect(record.raw_memory).toBe("edited")
      expect(record.edited_by).toBe("user")
      expect(typeof record.edited_at).toBe("number")
    }),
  )

  it.live("delete removes the record from the store", () =>
    Effect.gen(function* () {
      store = [makeRecord("thread-a", "a"), makeRecord("thread-b", "b")]
      const directory = yield* tmpdirScoped({ git: true, config: enabledConfig })

      const deleted = yield* requestInDirectory("/api/memory/thread-a", directory, { method: "DELETE" })
      expect(deleted.status).toBe(204)

      const missing = yield* requestInDirectory("/api/memory/thread-a", directory)
      expect(missing.status).toBe(404)

      const list = (yield* requestInDirectory("/api/memory", directory).pipe(Effect.flatMap((response) => response.json))) as {
        items: { thread_id: string }[]
      }
      expect(list.items.map((item) => item.thread_id)).toEqual(["thread-b"])
    }),
  )

  it.live("returns MemoryDisabledError when memory.enabled is not set", () =>
    Effect.gen(function* () {
      store = [makeRecord("thread-a")]
      const directory = yield* tmpdirScoped({ git: true, config: { memory: { enabled: false } } as never })

      const list = yield* requestInDirectory("/api/memory", directory)
      expect(list.status).toBe(409)
      expect(((yield* list.json) as { _tag: string })._tag).toBe("MemoryDisabledError")

      const get = yield* requestInDirectory("/api/memory/thread-a", directory)
      expect(get.status).toBe(409)

      const patch = yield* requestInDirectory("/api/memory/thread-a", directory, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw_memory: "x" }),
      })
      expect(patch.status).toBe(409)

      const del = yield* requestInDirectory("/api/memory/thread-a", directory, { method: "DELETE" })
      expect(del.status).toBe(409)
    }),
  )
})
