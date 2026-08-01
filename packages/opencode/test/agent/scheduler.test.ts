import { afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { createChildSessionAdapter, createWorktreeLeaseAdapter } from "../../src/agent/scheduler"
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
  )

  test("waits for the matching ready signal before resolving an acquired write lease", async () => {
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
      () =>
        Effect.callback<void>((resume) => {
          ready = () => resume(Effect.void)
          subscribed?.()
        }),
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
  })

  test("returns the parent location without a write lease for read-only children", async () => {
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

    const lease = await Effect.runPromise(
      Effect.scoped(adapter.acquire({ rootId: "root", taskId: "read", stateChanging: false })),
    )

    expect(lease.location).toEqual({ directory: "/parent" })
    expect(lease.write).toBe(false)
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
      () =>
        Effect.callback<void>((resume) => {
          ready = () => resume(Effect.void)
          subscribed?.()
        }),
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
      () => Effect.void,
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
    const calls: { create: unknown[]; prompt: unknown[]; wake: string[]; interrupt: string[] } = {
      create: [],
      prompt: [],
      wake: [],
      interrupt: [],
    }
    const adapter = createChildSessionAdapter({
      session: {
        create: (input) => Effect.sync(() => (calls.create.push(input), { id: input.id })),
        prompt: (input) => Effect.sync(() => (calls.prompt.push(input), { accepted: true })),
      },
      execution: {
        wake: (sessionID) => Effect.sync(() => void calls.wake.push(sessionID)),
        interrupt: (sessionID) => Effect.sync(() => void calls.interrupt.push(sessionID)),
      },
    })
    const input = {
      rootId: "root",
      taskId: "child",
      location: { directory: "/assigned" },
      prompt: "inspect the change",
    }

    const first = await Effect.runPromise(adapter.start(input))
    const second = await Effect.runPromise(adapter.start(input))

    expect(first).toEqual(second)
    expect(calls.create).toEqual([{ id: first.sessionId, location: { directory: "/assigned" } }])
    expect(calls.prompt).toEqual([
      { id: first.inputId, sessionID: first.sessionId, prompt: "inspect the change", resume: false },
    ])
    expect(calls.wake).toEqual([first.sessionId])
    expect(Object.keys(first)).toEqual(["sessionId", "inputId"])
  })

  test("delegates cancellation exactly once to Session execution interrupt", async () => {
    const interrupted: string[] = []
    const adapter = createChildSessionAdapter({
      session: {
        create: (input) => Effect.succeed({ id: input.id }),
        prompt: () => Effect.succeed({ accepted: true }),
      },
      execution: {
        wake: () => Effect.void,
        interrupt: (sessionID) => Effect.sync(() => void interrupted.push(sessionID)),
      },
    })
    const result = await Effect.runPromise(
      adapter.start({ rootId: "root", taskId: "child", location: { directory: "/assigned" }, prompt: "work" }),
    )

    await Effect.runPromise(adapter.cancel({ rootId: "root", taskId: "child" }))
    await Effect.runPromise(adapter.cancel({ rootId: "root", taskId: "child" }))

    expect(interrupted).toEqual([result.sessionId])
  })
})
