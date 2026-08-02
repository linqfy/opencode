import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SchedulerService, createReadApi, resolveSidecarBin } from "../../src/agent/scheduler-service"

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
    })
    await expect(api.taskGraph({ rootId: "root", workspaceDirectory: "C:\\workspace" })).resolves.toEqual({
      tasks: [], edges: [], next_cursor: null,
    })
    await expect(api.approvals({ workspaceDirectory: "C:\\workspace", projectId: "project" })).resolves.toEqual({
      items: [], next_cursor: null,
    })
  })
  test("prefers the explicit sidecar binary over the development binary", () => {
    expect(
      resolveSidecarBin({
        environment: { ULTRACODE_EVENTS_SIDECAR_BIN: "/configured/sidecar" },
        developmentBin: "/development/sidecar",
        exists: () => false,
      }),
    ).toBe("/configured/sidecar")
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
