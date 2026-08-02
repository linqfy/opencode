import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { createScheduler, type SchedulerEventClient, type TaskRecord } from "@ultracode/agents"
import {
  createChildSessionAdapter,
  createTaskSchedulerAdapter,
  createWorktreeLeaseAdapter,
} from "../../src/agent/scheduler"
import { GlobalBus } from "../../src/bus/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Worktree.node, FSUtil.node, Git.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
)

afterEach(() => disposeAllInstances())

class FakeSidecar implements SchedulerEventClient {
  readonly events: { key: string; kind: { kind: string; data: Record<string, unknown> } }[] = []
  readonly tasks: TaskRecord[] = []

  async listTasks(rootId: string) {
    return this.tasks.filter((task) => task.root_id === rootId)
  }

  async listMailbox() {
    return []
  }

  async listTaskDeliverables() {
    return []
  }

  async proposeCommit(key: string, kind: { kind: string; data: Record<string, unknown> }) {
    const existing = this.events.find((event) => event.key === key)
    if (existing) return { seq: this.events.indexOf(existing) + 1, hash: key, duplicate: true }
    this.events.push({ key, kind })
    if (kind.kind === "task-spawned") {
      this.tasks.push({
        root_id: kind.data.root_id as string,
        task_id: kind.data.task_id as string,
        parent_task_id: kind.data.parent_task_id as string | null,
        depth: kind.data.depth as number,
        state_changing: kind.data.state_changing as boolean,
        budget: kind.data.budget as number,
        reserved_parent: 600,
        reserved_child_pool: 10_000,
        reserved_synthesis: 100,
        budget_used: 0,
        state: "pending",
        dependencies: [],
      })
    }
    if (kind.kind === "task-state-changed") {
      const task = this.tasks.find((item) => item.root_id === kind.data.root_id && item.task_id === kind.data.task_id)
      if (task) (task as { state: string }).state = kind.data.state as string
    }
    return { seq: this.events.length, hash: key, duplicate: false }
  }
}

describe("scheduler worktree lease adapter", () => {
  it.instance(
    "assigns distinct ready worktrees to state-changing tasks and releases only the matching lease",
    () =>
      Effect.gen(function* () {
        const worktree = yield* Worktree.Service
        const adapter = createWorktreeLeaseAdapter({ directory: "parent" }, worktree)

        const first = yield* adapter.acquire({ rootId: "root-write", taskId: "one", stateChanging: true })
        const second = yield* adapter.acquire({ rootId: "root", taskId: "write-one", stateChanging: true })

        expect(first.location.directory).not.toBe(second.location.directory)
        expect(first.branch).not.toBe(second.branch)
        expect(first.ready).toBe(true)
        expect(second.ready).toBe(true)
        expect(yield* Effect.exit(adapter.release({ rootId: "root", taskId: "wrong-task" }))).toMatchObject({
          _tag: "Failure",
        })

        yield* adapter.release({ rootId: "root-write", taskId: "one" })
        const activeDirectories = (yield* worktree.list()).map((item) => item.directory.toLowerCase())
        expect(activeDirectories).not.toContain(first.location.directory.toLowerCase())
        expect(activeDirectories).toContain(second.location.directory.toLowerCase())
        yield* adapter.release({ rootId: "root", taskId: "write-one" })
      }),
    { git: true },
    { timeout: 30_000 },
  )

  test("waits for the matching ready signal before resolving an acquired write lease", async () => {
    let ready: (() => void) | undefined
    let disposed = false
    let subscribed: (() => void) | undefined
    const subscribedPromise = new Promise<void>((resolve) => {
      subscribed = resolve
    })
    const adapter = createWorktreeLeaseAdapter(
      { directory: "/parent" },
      {
        makeWorktreeInfo: () =>
          Effect.succeed({
            name: "scheduler-726f6f74-7461736b",
            branch: "opencode/scheduler-726f6f74-7461736b",
            directory: "/child",
          }),
        createFromInfo: () => Effect.void,
        create: () => Effect.die("unexpected"),
        list: () => Effect.succeed([]),
        remove: () => Effect.succeed(true),
        reset: () => Effect.succeed(true),
      },
      (_, resolve) => {
        ready = () => resolve(Effect.void)
        subscribed?.()
        return () => void (disposed = true)
      },
    )

    let resolved = false
    const pending = Effect.runPromise(
      Effect.scoped(adapter.acquire({ rootId: "root", taskId: "task", stateChanging: true })),
    ).then(() => {
      resolved = true
    })
    await subscribedPromise
    expect(resolved).toBe(false)
    ready?.()
    await pending
    expect(resolved).toBe(true)
    expect(disposed).toBe(true)
  })

  test("subscribes before creation, rejects a matching worktree failure, and disposes the listener", async () => {
    const listeners = GlobalBus.listenerCount("event")
    const adapter = createWorktreeLeaseAdapter(
      { directory: "/parent" },
      {
        makeWorktreeInfo: () => Effect.succeed({ name: "child", branch: "opencode/child", directory: "/child" }),
        createFromInfo: () =>
          Effect.sync(() =>
            GlobalBus.emit("event", {
              directory: "/child",
              payload: { type: Worktree.Event.Failed.type, properties: { message: "bootstrap failed" } },
            }),
          ),
        create: () => Effect.die("unexpected"),
        list: () => Effect.succeed([]),
        remove: () => Effect.succeed(true),
        reset: () => Effect.succeed(true),
      },
    )

    await expect(
      Effect.runPromise(Effect.scoped(adapter.acquire({ rootId: "root", taskId: "task", stateChanging: true }))),
    ).rejects.toThrow("bootstrap failed")
    expect(GlobalBus.listenerCount("event")).toBe(listeners)
  })

  test("does not permit a read-only scheduler child", async () => {
    let created = false
    const adapter = createWorktreeLeaseAdapter(
      { directory: "/parent" },
      {
        makeWorktreeInfo: () => Effect.die("unexpected"),
        createFromInfo: () => Effect.sync(() => void (created = true)),
        create: () => Effect.die("unexpected"),
        list: () => Effect.succeed([]),
        remove: () => Effect.succeed(true),
        reset: () => Effect.succeed(true),
      },
    )

    await expect(
      Effect.runPromise(Effect.scoped(adapter.acquire({ rootId: "root", taskId: "read", stateChanging: false }))),
    ).rejects.toThrow("state-changing")
    expect(created).toBe(false)
  })

  test("rejects a second lease request for a task while its worktree is becoming ready", async () => {
    let ready: (() => void) | undefined
    let subscribed: (() => void) | undefined
    const subscribedPromise = new Promise<void>((resolve) => {
      subscribed = resolve
    })
    const adapter = createWorktreeLeaseAdapter(
      { directory: "/parent" },
      {
        makeWorktreeInfo: () =>
          Effect.succeed({
            name: "scheduler-726f6f74-7461736b",
            branch: "opencode/scheduler-726f6f74-7461736b",
            directory: "/child",
          }),
        createFromInfo: () => Effect.void,
        create: () => Effect.die("unexpected"),
        list: () => Effect.succeed([]),
        remove: () => Effect.succeed(true),
        reset: () => Effect.succeed(true),
      },
      (_, resolve) => {
        ready = () => resolve(Effect.void)
        subscribed?.()
        return () => {}
      },
    )
    const input = { rootId: "root", taskId: "task", stateChanging: true }
    const first = Effect.runPromise(Effect.scoped(adapter.acquire(input)))
    await subscribedPromise
    const second = Effect.runPromise(Effect.scoped(adapter.acquire(input)))

    ready?.()
    await first
    await expect(second).rejects.toThrow("already exists")
  })

  test("cleans up its own write lease when child work fails or is cancelled", async () => {
    const removed: string[] = []
    const adapter = createWorktreeLeaseAdapter(
      { directory: "/parent" },
      {
        makeWorktreeInfo: () =>
          Effect.succeed({
            name: "scheduler-726f6f74-7461736b",
            branch: "opencode/scheduler-726f6f74-7461736b",
            directory: "/child",
          }),
        createFromInfo: () => Effect.void,
        create: () => Effect.die("unexpected"),
        list: () => Effect.succeed([]),
        remove: ({ directory }) => Effect.sync(() => (removed.push(directory), true)),
        reset: () => Effect.succeed(true),
      },
      (_, resolve) => {
        resolve(Effect.void)
        return () => {}
      },
    )

    await expect(
      Effect.runPromise(
        Effect.scoped(
          adapter.use({ rootId: "root", taskId: "task", stateChanging: true }, () => Effect.fail(new Error("failed"))),
        ),
      ),
    ).rejects.toThrow("failed")
    expect(removed).toEqual(["/child"])
  })
})

describe("scheduler child Session V2 adapter", () => {
  test("does not import or invoke legacy child execution loops", async () => {
    const source = await Bun.file(new URL("../../src/agent/scheduler.ts", import.meta.url)).text()

    expect(source).not.toContain("SessionPrompt.loop")
    expect(source).not.toContain("BackgroundJob")
  })

  test("creates a deterministic child session and admits exactly one prompt at its assigned location", async () => {
    const calls: { create: unknown[]; prompt: unknown[]; supervise: unknown[]; interrupt: string[] } = {
      create: [],
      prompt: [],
      supervise: [],
      interrupt: [],
    }
    const adapter = createChildSessionAdapter({
      session: {
        create: (input) => Effect.sync(() => (calls.create.push(input), { id: input.id })),
        prompt: (input) => Effect.sync(() => (calls.prompt.push(input), { accepted: true })),
      },
      execution: {
        supervise: (input) =>
          Effect.sync(() => {
            calls.supervise.push(input)
            return {
              status: "completed",
              usage: { tokens: 1, turns: 1, elapsedMs: 1 },
              artifactIds: [],
              changedPaths: [],
            }
          }),
        interrupt: (sessionID) => Effect.sync(() => void calls.interrupt.push(sessionID)),
      },
    })
    const input = {
      rootId: "root",
      taskId: "child",
      location: { directory: "/assigned" },
      prompt: "inspect the change",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
      toolConstraints: ["read"],
      maxTurns: 2,
      maxTokens: 100,
      timeoutMs: 1_000,
      forkMode: "recent" as const,
      parent: { sessionID: "parent-session", messageID: "parent-message" },
    }

    const first = await Effect.runPromise(adapter.start(input))
    const second = await Effect.runPromise(adapter.start(input))

    expect(first).toEqual(second)
    expect(calls.create).toEqual([
      expect.objectContaining({
        id: first.sessionId,
        location: { directory: "/assigned" },
        agent: "build",
        model: { providerID: "test", modelID: "model" },
        toolConstraints: ["read"],
        maxTurns: 2,
        forkMode: "recent",
        parent: { sessionID: "parent-session", messageID: "parent-message" },
      }),
    ])
    expect(calls.prompt).toEqual([
      { id: first.inputId, sessionID: first.sessionId, prompt: "inspect the change", resume: false },
    ])
    expect(calls.supervise).toEqual([{ sessionID: first.sessionId, maxTurns: 2, maxTokens: 100, timeoutMs: 1_000 }])
    expect(Object.keys(first)).toEqual(["sessionId", "inputId", "terminal"])
  })

  test("delegates cancellation exactly once to Session execution interrupt", async () => {
    const interrupted: string[] = []
    const adapter = createChildSessionAdapter({
      session: {
        create: (input) => Effect.succeed({ id: input.id }),
        prompt: () => Effect.succeed({ accepted: true }),
      },
      execution: {
        supervise: () =>
          Effect.succeed({
            status: "completed",
            usage: { tokens: 0, turns: 0, elapsedMs: 0 },
            artifactIds: [],
            changedPaths: [],
          }),
        interrupt: (sessionID) => Effect.sync(() => void interrupted.push(sessionID)),
      },
    })
    const result = await Effect.runPromise(
      adapter.start({
        rootId: "root",
        taskId: "child",
        location: { directory: "/assigned" },
        prompt: "work",
        agent: "build",
        model: { providerID: "test", modelID: "model" },
        toolConstraints: [],
        maxTurns: 1,
        maxTokens: 100,
        timeoutMs: 1_000,
        forkMode: "none",
        parent: { sessionID: "parent-session", messageID: "parent-message" },
      }),
    )

    await Effect.runPromise(adapter.cancel({ rootId: "root", taskId: "child" }))
    await Effect.runPromise(adapter.cancel({ rootId: "root", taskId: "child" }))

    expect(interrupted).toEqual([result.sessionId])
  })
})

describe("durable task scheduler adapter", () => {
  test("fails closed before scheduling when any execution cap is absent", async () => {
    const adapter = createTaskSchedulerAdapter({
      scheduler: createScheduler(new FakeSidecar()),
      worktree: undefined as never,
      child: undefined as never,
    })

    await expect(
      Effect.runPromise(
        adapter.schedule({
          brief: "work",
          description: "work",
          agent: { name: "build", model: { providerID: "test", modelID: "model" }, toolConstraints: [] },
          forkMode: "none",
          budget: { maxTurns: 1, maxTokens: 100 },
          background: false,
          parent: {
            rootId: "ignored",
            taskId: "ignored",
            sessionID: "ses_parent" as never,
            messageID: "msg_parent" as never,
          },
        }),
      ),
    ).rejects.toThrow("maxTokens, maxTurns, and maxTimeMs")
  })

  test("commits a deterministic root and child lineage once before starting its isolated child session", async () => {
    const sidecar = new FakeSidecar()
    const created: unknown[] = []
    const worktree = createWorktreeLeaseAdapter(
      { directory: "/parent" },
      {
        makeWorktreeInfo: () => Effect.succeed({ name: "child", branch: "opencode/child", directory: "/child" }),
        createFromInfo: () => Effect.void,
        create: () => Effect.die("unexpected"),
        list: () => Effect.succeed([]),
        remove: () => Effect.succeed(true),
        reset: () => Effect.succeed(true),
      },
      (_, resolve) => {
        resolve(Effect.void)
        return () => {}
      },
    )
    const child = createChildSessionAdapter({
      session: {
        create: (input) => Effect.sync(() => (created.push(input), { id: input.id })),
        prompt: () => Effect.succeed({}),
      },
      execution: {
        supervise: () =>
          Effect.succeed({
            status: "completed",
            usage: { tokens: 0, turns: 0, elapsedMs: 0 },
            artifactIds: [],
            changedPaths: [],
          }),
        interrupt: () => Effect.succeed({ observed: true }),
      },
    })
    const adapter = createTaskSchedulerAdapter({
      scheduler: createScheduler(sidecar),
      worktree,
      child,
    })
    const request = {
      brief: "fix the scheduler",
      description: "fix scheduler",
      agent: { name: "build", model: { providerID: "test", modelID: "model" }, toolConstraints: ["read", "write"] },
      forkMode: "recent" as const,
      budget: { maxTurns: 4, maxTokens: 1_000, maxTimeMs: 1_000 },
      background: false,
      parent: {
        rootId: "ignored",
        taskId: "ignored",
        sessionID: "ses_parent" as never,
        messageID: "msg_parent" as never,
      },
    }

    const first = await Effect.runPromise(adapter.schedule(request))
    const second = await Effect.runPromise(adapter.schedule(request))

    expect(first.taskId).toBe(second.taskId)
    expect(created).toHaveLength(1)
    expect(created).toEqual([
      expect.objectContaining({
        agent: "build",
        model: { providerID: "test", modelID: "model" },
        toolConstraints: ["read", "write"],
        maxTurns: 4,
        forkMode: "recent",
        parent: { sessionID: "ses_parent", messageID: "msg_parent" },
        location: { directory: "/child" },
      }),
    ])
    expect(sidecar.tasks).toEqual([
      expect.objectContaining({ task_id: expect.stringMatching(/^root_/), parent_task_id: null, depth: 0 }),
      expect.objectContaining({
        task_id: first.taskId,
        parent_task_id: expect.stringMatching(/^root_/),
        depth: 1,
        state_changing: true,
      }),
    ])
    const leased = sidecar.events.find((event) => event.kind.kind === "worktree-leased")
    expect(leased?.kind.data).toEqual({ root_id: first.rootId, task_id: first.taskId, worktree_id: "/child" })

    expect(
      await Effect.runPromise(adapter.cancel({ rootId: first.rootId, taskId: first.taskId, reason: "complete" })),
    ).toEqual({
      state: "cancelled",
    })
    const released = sidecar.events.find((event) => event.kind.kind === "worktree-released")
    expect(released?.kind.data).toEqual({ root_id: first.rootId, task_id: first.taskId, worktree_id: "/child" })
  })

  test("does not start a child session or lease durably when its subscribed worktree readiness fails", async () => {
    const sidecar = new FakeSidecar()
    const created: unknown[] = []
    const worktree = createWorktreeLeaseAdapter(
      { directory: "/parent" },
      {
        makeWorktreeInfo: () => Effect.succeed({ name: "child", branch: "opencode/child", directory: "/child" }),
        createFromInfo: () => Effect.void,
        create: () => Effect.die("unexpected"),
        list: () => Effect.succeed([]),
        remove: () => Effect.succeed(true),
        reset: () => Effect.succeed(true),
      },
      (_, resolve) => {
        resolve(Effect.fail(new Error("worktree bootstrap failed")))
        return () => {}
      },
    )
    const child = createChildSessionAdapter({
      session: {
        create: (input) => Effect.sync(() => (created.push(input), { id: input.id })),
        prompt: () => Effect.succeed({}),
      },
      execution: {
        supervise: () =>
          Effect.succeed({
            status: "completed",
            usage: { tokens: 0, turns: 0, elapsedMs: 0 },
            artifactIds: [],
            changedPaths: [],
          }),
        interrupt: () => Effect.void,
      },
    })
    const adapter = createTaskSchedulerAdapter({
      scheduler: createScheduler(sidecar),
      worktree,
      child,
    })

    await expect(
      Effect.runPromise(
        adapter.schedule({
          brief: "work",
          description: "work",
          agent: { name: "build", model: { providerID: "test", modelID: "model" }, toolConstraints: [] },
          forkMode: "none",
          budget: { maxTurns: 1, maxTokens: 1_000, maxTimeMs: 1_000 },
          background: false,
          parent: {
            rootId: "ignored",
            taskId: "ignored",
            sessionID: "ses_parent" as never,
            messageID: "msg_parent" as never,
          },
        }),
      ),
    ).rejects.toThrow("worktree bootstrap failed")

    expect(created).toEqual([])
    expect(sidecar.events.map((event) => event.kind.kind)).not.toContain("worktree-leased")
  })

  test("does not release or acknowledge cancellation without lifecycle observation", async () => {
    const sidecar = new FakeSidecar()
    const released: string[] = []
    const worktree = createWorktreeLeaseAdapter(
      { directory: "/parent" },
      {
        makeWorktreeInfo: () => Effect.succeed({ name: "child", branch: "opencode/child", directory: "/child" }),
        createFromInfo: () => Effect.void,
        create: () => Effect.die("unexpected"),
        list: () => Effect.succeed([]),
        remove: ({ directory }) => Effect.sync(() => (released.push(directory), true)),
        reset: () => Effect.succeed(true),
      },
      (_, resolve) => {
        resolve(Effect.void)
        return () => {}
      },
    )
    const child = createChildSessionAdapter({
      session: { create: (input) => Effect.succeed({ id: input.id }), prompt: () => Effect.succeed({}) },
      execution: {
        supervise: () =>
          Effect.succeed({
            status: "completed",
            usage: { tokens: 0, turns: 0, elapsedMs: 0 },
            artifactIds: [],
            changedPaths: [],
          }),
        interrupt: () => Effect.void,
      },
    })
    const adapter = createTaskSchedulerAdapter({
      scheduler: createScheduler(sidecar),
      worktree,
      child,
    })
    const handle = await Effect.runPromise(
      adapter.schedule({
        brief: "work",
        description: "work",
        agent: { name: "build", model: { providerID: "test", modelID: "model" }, toolConstraints: [] },
        forkMode: "none",
        budget: { maxTurns: 1, maxTokens: 1_000, maxTimeMs: 1_000 },
        background: false,
        parent: {
          rootId: "ignored",
          taskId: "ignored",
          sessionID: "ses_parent" as never,
          messageID: "msg_parent" as never,
        },
      }),
    )

    const result = await Effect.runPromise(
      adapter.cancel({ rootId: handle.rootId, taskId: handle.taskId, reason: "stop" }),
    )

    expect(result).toEqual({ state: "cancellation_pending" })
    expect(released).toEqual([])
    expect(sidecar.events.map((event) => event.kind.kind)).not.toContain("worktree-released")
    expect(sidecar.events.map((event) => event.kind.kind)).not.toContain("task-cancellation-observed")
  })
})
