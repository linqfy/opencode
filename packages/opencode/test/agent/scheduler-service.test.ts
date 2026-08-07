import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import path from "node:path"
import { EventV2 } from "@opencode-ai/core/event"
import { SchedulerService, createReadApi } from "../../src/agent/scheduler-service"
import { Worktree } from "@/worktree"

const runtime = {
  parentLocation: () => Effect.succeed({ directory: "/workspace" }),
  worktree: {
    makeWorktreeInfo: () => Effect.die("unexpected"),
    createFromInfo: () => Effect.die("unexpected"),
    create: () => Effect.die("unexpected"),
    list: () => Effect.succeed([]),
    remove: () => Effect.succeed(true),
    reset: () => Effect.succeed(true),
  },
  session: {
    create: () => Effect.die("unexpected"),
    prompt: () => Effect.die("unexpected"),
  },
  execution: {
    supervise: () => Effect.die("unexpected"),
    interrupt: () => Effect.die("unexpected"),
  },
}

describe("SchedulerService", () => {
  test("exposes location-scoped neutral read APIs through the events client", async () => {
    const api = createReadApi({
      queryTaskGraph: async () => ({ tasks: [], edges: [], next_cursor: null }),
      listApprovalHistory: async () => ({ items: [], next_cursor: null }),
      queryTaskDeliverables: async () => ({ items: [], next_cursor: null }),
      replay: async () => [],
      statArtifact: async () => null,
      openRange: async () => new Uint8Array(),
      cancelTask: async () => ({ state: "cancellation_pending" as const }),
      listMemoryRecords: async () => [],
      getMemoryRecord: async () => null,
      deleteMemoryRecord: async () => ({ seq: 1, hash: "h", duplicate: false }),
      patchMemoryRecord: async () => ({ seq: 1, hash: "h", duplicate: false }),
    })
    await expect(api.taskGraph({ rootId: "root", workspaceDirectory: "C:\\workspace" })).resolves.toEqual({
      tasks: [], edges: [], next_cursor: null,
    })
    await expect(api.approvals({ workspaceDirectory: "C:\\workspace", projectId: "project" })).resolves.toEqual({
      items: [], next_cursor: null,
    })
  })
  test("layer resolves the repo dev sidecar when no env override is set", async () => {
    const previous = process.env.ULTRACODE_EVENTS_SIDECAR_BIN
    delete process.env.ULTRACODE_EVENTS_SIDECAR_BIN
    try {
      if (!existsSync(path.join(import.meta.dir, "..", "..", "..", "..", "target", "debug", process.platform === "win32" ? "sidecar.exe" : "sidecar"))) return
      const deps = Layer.mergeAll(
        Layer.mock(Worktree.Service, {}),
        Layer.mock(EventV2.Service, { listen: () => Effect.succeed(Effect.void) }),
      )
      await expect(
        Effect.runPromise(
          Effect.scoped(SchedulerService.Service.use((service) => service.adapter)).pipe(
            Effect.provide(SchedulerService.layer.pipe(Layer.provide(deps))),
          ),
        ),
      ).resolves.toBeTruthy()
    } finally {
      if (previous === undefined) delete process.env.ULTRACODE_EVENTS_SIDECAR_BIN
      else process.env.ULTRACODE_EVENTS_SIDECAR_BIN = previous
    }
  })

  test("fails closed when startup ping fails", async () => {
    let stopped = 0
    const layer = SchedulerService.layerWith({
      sidecarBin: "/sidecar",
      paths: {
        journalDir: "/state/ultracode-events/journal",
        db: "/state/ultracode-events/events.db",
        artifacts: "/data/artifacts",
      },
      start: () =>
        ({ ping: async () => Promise.reject(new Error("ping failed")), stop: () => void stopped++ }) as never,
      runtime,
    })

    await expect(
      Effect.runPromise(
        Effect.scoped(SchedulerService.Service.use((service) => service.adapter)).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("ping failed")
    expect(stopped).toBe(1)
  })

  test("stops its client when the service scope closes", async () => {
    let stopped = 0
    const layer = SchedulerService.layerWith({
      sidecarBin: "/sidecar",
      paths: {
        journalDir: "/state/ultracode-events/journal",
        db: "/state/ultracode-events/events.db",
        artifacts: "/data/artifacts",
      },
      start: () => ({ ping: async () => ({ ok: true }), stop: () => void stopped++ }) as never,
      runtime,
    })

    await Effect.runPromise(
      Effect.scoped(SchedulerService.Service.use((service) => service.adapter)).pipe(Effect.provide(layer)),
    )
    expect(stopped).toBe(1)
  })
})
