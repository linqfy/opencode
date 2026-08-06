import { describe, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { createScheduler, type SchedulerEventClient, type TaskRecord } from "@ultracode/agents"
import type { SessionExecution } from "@opencode-ai/core/session/execution"
import { createReadApi, type ReadApi } from "../../src/agent/scheduler-service"
import {
  createChildSessionAdapter,
  createTaskSchedulerAdapter,
  createWorktreeLeaseAdapter,
} from "../../src/agent/scheduler"

// In-memory SchedulerEventClient harness copied from
// packages/ultracode-agents/test/scheduler.test.ts, extended with cancelTask (the read API's
// degraded sidecar path) and an onCommit readiness signal.
type EventKind = { readonly kind: string; readonly data: Record<string, unknown> }
type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] }
type MutableTaskRecord = Mutable<TaskRecord>

class FakeEventClient implements SchedulerEventClient {
  readonly events: { key: string; kind: EventKind }[] = []
  readonly tasks: MutableTaskRecord[] = []
  readonly mailbox: {
    root_id: string
    message_id: string
    sender_task_id: string
    recipient_task_id: string
    sequence: number
    summary: string
    artifact_ids: string[]
    changed_paths: string[]
    test_summary: string | null
    blocked_reason: string | null
    acknowledged: boolean
  }[] = []
  readonly deliverables: {
    root_id: string
    task_id: string
    status: string
    summary: string
    artifact_ids: string[]
    changed_paths: string[]
    test_summary: string | null
  }[] = []
  onCommit?: (event: { key: string; kind: EventKind }) => void

  async listTasks(rootId: string, _workspaceDirectory: string, limit: number) {
    return this.tasks.filter((task) => task.root_id === rootId).slice(0, limit)
  }

  async listMailbox(rootId: string, _workspaceDirectory: string, recipientTaskId: string, afterSequence: number, limit: number) {
    return this.mailbox
      .filter((message) => message.root_id === rootId && message.recipient_task_id === recipientTaskId && message.sequence > afterSequence)
      .slice(0, limit)
  }

  async listTaskDeliverables(rootId: string, _workspaceDirectory: string, limit: number) {
    return this.deliverables.filter((deliverable) => deliverable.root_id === rootId).slice(0, limit)
  }

  async cancelTask(rootId: string, taskId: string, _workspaceDirectory: string, reason: string, idempotencyKey: string) {
    const task = this.task(rootId, taskId)
    if (["completed", "failed", "cancelled"].includes(task.state)) return { state: "cancelled" as const }
    await this.proposeCommit(idempotencyKey, {
      kind: "task-cancellation-requested",
      data: { root_id: rootId, task_id: taskId, reason },
    })
    return { state: "cancellation_pending" as const }
  }

  async proposeCommit(key: string, kind: EventKind) {
    const duplicate = this.events.find((event) => event.key === key)
    if (duplicate) return { seq: this.events.indexOf(duplicate) + 1, hash: key, duplicate: true }
    const data = kind.data
    if (kind.kind === "task-cancellation-observed" && this.task(data.root_id as string, data.task_id as string).state !== "cancelled") {
      throw new Error("task is not cancelled")
    }
    this.events.push({ key, kind })
    this.onCommit?.({ key, kind })
    if (kind.kind === "task-spawned") {
      this.tasks.push({
        root_id: data.root_id as string,
        task_id: data.task_id as string,
        parent_task_id: data.parent_task_id as string | null,
        depth: data.depth as number,
        state_changing: data.state_changing as boolean,
        budget: data.budget as number,
        reserved_parent: 0,
        reserved_child_pool: 0,
        reserved_synthesis: 0,
        budget_used: 0,
        budget_reclaimed: 0,
        state: "pending",
        dependencies: data.dependencies as string[],
      })
    }
    if (kind.kind === "task-budget-reserved") {
      const task = this.task(data.root_id as string, data.task_id as string)
      task.reserved_parent = data.parent as number
      task.reserved_child_pool = data.child_pool as number
      task.reserved_synthesis = data.synthesis as number
    }
    if (kind.kind === "task-budget-reclaimed") this.task(data.root_id as string, data.task_id as string).budget_reclaimed! += data.amount as number
    if (kind.kind === "task-state-changed") this.task(data.root_id as string, data.task_id as string).state = data.state as string
    if (kind.kind === "task-cancellation-requested") this.task(data.root_id as string, data.task_id as string).state = "cancelled"
    if (kind.kind === "mailbox-message-sent") {
      this.mailbox.push({
        root_id: data.root_id as string,
        message_id: data.message_id as string,
        sender_task_id: data.sender_task_id as string,
        recipient_task_id: data.recipient_task_id as string,
        sequence: data.sequence as number,
        summary: data.summary as string,
        artifact_ids: data.artifact_ids as string[],
        changed_paths: data.changed_paths as string[],
        test_summary: data.test_summary as string | null,
        blocked_reason: data.blocked_reason as string | null,
        acknowledged: false,
      })
    }
    if (kind.kind === "task-deliverable-committed") this.deliverables.push(data as never)
    return { seq: this.events.length, hash: key, duplicate: false }
  }

  private task(rootId: string, taskId: string) {
    const task = this.tasks.find((item) => item.root_id === rootId && item.task_id === taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    return task
  }
}

type Harness = {
  readonly client: FakeEventClient
  readonly adapter: ReturnType<typeof createTaskSchedulerAdapter>
  readonly supervised: string[]
  readonly interrupted: string[]
  readonly supervisionStarted: Promise<void>
  readonly committed: Promise<void>
}

function harness(terminal: Deferred.Deferred<SessionExecution.TerminalRunResult, never>): Harness {
  const supervised: string[] = []
  const interrupted: string[] = []
  let started: (() => void) | undefined
  const supervisionStarted = new Promise<void>((resolve) => (started = resolve))
  let commit: (() => void) | undefined
  const committed = new Promise<void>((resolve) => (commit = resolve))
  const client = new FakeEventClient()
  client.onCommit = (event) => {
    if (event.kind.kind === "task-deliverable-committed") commit?.()
  }
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
  const adapter = createTaskSchedulerAdapter({
    scheduler: createScheduler(client),
    worktree,
    child: createChildSessionAdapter({
      session: { create: (input) => Effect.succeed({ id: input.id }), prompt: () => Effect.succeed({}) },
      execution: {
        supervise: (input) =>
          Effect.sync(() => {
            supervised.push(input.sessionID)
            started?.()
          }).pipe(Effect.andThen(Deferred.await(terminal))),
        interrupt: (sessionID) =>
          Effect.sync(() => {
            interrupted.push(sessionID)
            return { observed: true }
          }),
      },
    }),
  })
  return { client, adapter, supervised, interrupted, supervisionStarted, committed }
}

function readClient(client: FakeEventClient): Parameters<typeof createReadApi>[0] {
  return {
    queryTaskGraph: async () => ({ tasks: [], edges: [], next_cursor: null }),
    listApprovalHistory: async () => ({ items: [], next_cursor: null }),
    queryTaskDeliverables: async () => ({ items: [], next_cursor: null }),
    replay: async () => [],
    statArtifact: async () => null,
    openRange: async () => new Uint8Array(),
    cancelTask: client.cancelTask.bind(client),
  }
}

const request = {
  brief: "work",
  description: "work",
  agent: { name: "build", model: { providerID: "test", modelID: "model" }, toolConstraints: [] },
  forkMode: "none" as const,
  budget: { maxTurns: 2, maxTokens: 1_000, maxTimeMs: 1_000 },
  background: true,
  parent: { rootId: "ignored", taskId: "ignored", sessionID: "ses_parent" as never, messageID: "msg_parent" as never },
}

const cancelledTerminal = {
  status: "cancelled" as const,
  usage: { tokens: 0, turns: 0, elapsedMs: 0 },
  artifactIds: [],
  changedPaths: [],
}

describe("scheduler cancellation dispatch", () => {
  test("interrupts a live child exactly once and journals the cancelled deliverable after it settles", async () => {
    const terminal = await Effect.runPromise(Deferred.make<SessionExecution.TerminalRunResult, never>())
    const { client, adapter, supervised, interrupted, supervisionStarted, committed } = harness(terminal)

    const handle = await Effect.runPromise(adapter.schedule(request))
    expect(handle.status).toBe("running")
    await supervisionStarted

    await expect(
      Effect.runPromise(adapter.cancel({ rootId: handle.rootId, taskId: handle.taskId, reason: "user stopped" })),
    ).resolves.toEqual({ state: "cancellation_pending" })

    await Effect.runPromise(Deferred.succeed(terminal, cancelledTerminal))
    await committed

    expect(interrupted).toEqual([supervised[0]])
    expect(client.deliverables.find((deliverable) => deliverable.task_id === handle.taskId)?.status).toBe("cancelled")
    const kinds = client.events.map((event) => event.kind.kind)
    expect(kinds.indexOf("task-cancellation-requested")).toBeGreaterThanOrEqual(0)
    expect(kinds.indexOf("task-cancellation-observed")).toBeGreaterThan(kinds.indexOf("task-cancellation-requested"))
    expect(kinds.indexOf("task-deliverable-committed")).toBeGreaterThan(kinds.indexOf("task-cancellation-observed"))
  })

  test("routes the read-api cancel through the adapter so interruption precedes the durable ack", async () => {
    const terminal = await Effect.runPromise(Deferred.make<SessionExecution.TerminalRunResult, never>())
    const { client, adapter, supervised, interrupted, supervisionStarted, committed } = harness(terminal)
    const read: ReadApi = createReadApi(readClient(client), adapter)

    const handle = await Effect.runPromise(adapter.schedule(request))
    await supervisionStarted

    await expect(
      read.cancel({
        rootId: handle.rootId,
        taskId: handle.taskId,
        workspaceDirectory: "/workspace",
        reason: "user stopped",
        idempotencyKey: "caller-cancel-key",
      }),
    ).resolves.toEqual({ state: "cancellation_pending" })

    await Effect.runPromise(Deferred.succeed(terminal, cancelledTerminal))
    await committed

    expect(interrupted).toEqual([supervised[0]])
    expect(client.deliverables.find((deliverable) => deliverable.task_id === handle.taskId)?.status).toBe("cancelled")
    expect(client.events.find((event) => event.kind.kind === "task-cancellation-requested")?.key).toBe(
      `task:${handle.rootId}:${handle.taskId}:cancel`,
    )
    const kinds = client.events.map((event) => event.kind.kind)
    expect(kinds.indexOf("task-cancellation-observed")).toBeGreaterThan(kinds.indexOf("task-cancellation-requested"))
    expect(kinds.indexOf("task-deliverable-committed")).toBeGreaterThan(kinds.indexOf("task-cancellation-observed"))
  })

  test("degrades to the sidecar cancel_task call when no adapter is available", async () => {
    const client = new FakeEventClient()
    const read: ReadApi = createReadApi(readClient(client))
    await client.proposeCommit("spawn", {
      kind: "task-spawned",
      data: {
        root_id: "root",
        task_id: "task",
        parent_task_id: null,
        depth: 0,
        state_changing: false,
        dependencies: [],
        budget: 1_000,
      },
    })

    await expect(
      read.cancel({
        rootId: "root",
        taskId: "task",
        workspaceDirectory: "/workspace",
        reason: "stop",
        idempotencyKey: "caller-cancel-key",
      }),
    ).resolves.toEqual({ state: "cancellation_pending" })
    expect(client.events.find((event) => event.kind.kind === "task-cancellation-requested")?.key).toBe("caller-cancel-key")
    expect(client.tasks.find((task) => task.task_id === "task")?.state).toBe("cancelled")
  })
})
