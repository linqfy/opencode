import { describe, expect, test } from "bun:test"
import { createScheduler, type SchedulerEventClient, type TaskRecord } from "@ultracode/agents"
import { Effect } from "effect"
import {
  createChildSessionAdapter,
  createTaskSchedulerAdapter,
  createWorktreeLeaseAdapter,
  deriveExecutionLimits,
} from "../../src/agent/scheduler"

class FakeSidecar implements SchedulerEventClient {
  readonly events: { key: string; kind: { kind: string; data: Record<string, unknown> } }[] = []
  readonly tasks: TaskRecord[] = []
  onCommit?: (event: { key: string; kind: { kind: string; data: Record<string, unknown> } }) => void
  readonly deliverables: {
    root_id: string
    task_id: string
    status: string
    summary: string
    artifact_ids: readonly string[]
    changed_paths: readonly string[]
    test_summary: string | null
  }[] = []

  async listTasks(rootId: string) {
    return this.tasks.filter((task) => task.root_id === rootId)
  }

  async listMailbox() {
    return []
  }

  async listTaskDeliverables() {
    return this.deliverables
  }

  async proposeCommit(key: string, kind: { kind: string; data: Record<string, unknown> }) {
    if (this.failKey === key) {
      this.failKey = undefined
      throw new Error(`injected commit failure: ${key}`)
    }
    const existing = this.events.find((event) => event.key === key)
    if (existing) return { seq: this.events.indexOf(existing) + 1, hash: key, duplicate: true }
    const event = { key, kind }
    this.events.push(event)
    this.onCommit?.(event)
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
        budget_reclaimed: 0,
        state: "pending",
        dependencies: [],
      })
    }
    if (kind.kind === "task-state-changed") {
      const task = this.tasks.find((item) => item.root_id === kind.data.root_id && item.task_id === kind.data.task_id)
      if (task) (task as { state: string }).state = kind.data.state as string
    }
    if (kind.kind === "task-cancellation-requested") {
      const task = this.tasks.find((item) => item.root_id === kind.data.root_id && item.task_id === kind.data.task_id)
      if (task) (task as { state: string }).state = "cancelled"
    }
    if (kind.kind === "task-budget-used") {
      const task = this.tasks.find((item) => item.root_id === kind.data.root_id && item.task_id === kind.data.task_id)
      if (task) (task as { budget_used: number }).budget_used += kind.data.amount as number
    }
    if (kind.kind === "task-budget-reclaimed") {
      const task = this.tasks.find((item) => item.root_id === kind.data.root_id && item.task_id === kind.data.task_id)
      if (task) (task as { budget_reclaimed: number }).budget_reclaimed += kind.data.amount as number
    }
    if (kind.kind === "task-deliverable-committed") {
      this.deliverables.push({
        root_id: kind.data.root_id as string,
        task_id: kind.data.task_id as string,
        status: kind.data.status as string,
        summary: kind.data.summary as string,
        artifact_ids: kind.data.artifact_ids as readonly string[],
        changed_paths: kind.data.changed_paths as readonly string[],
        test_summary: kind.data.test_summary as string | null,
      })
    }
    return { seq: this.events.length, hash: key, duplicate: false }
  }

  failKey?: string
}

const worktree = () =>
  createWorktreeLeaseAdapter(
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

const request = {
  brief: "work",
  description: "work",
  agent: { name: "build", model: { providerID: "test", modelID: "model" }, toolConstraints: [] },
  forkMode: "none" as const,
  budget: { maxTurns: 2, maxTokens: 100_000, maxTimeMs: 1_000 },
  background: false,
  parent: { rootId: "ignored", taskId: "ignored", sessionID: "ses_parent" as never, messageID: "msg_parent" as never },
}

describe("budget spine", () => {
  test("deriveExecutionLimits takes the DAG reservation as the single maxTokens source", () => {
    expect(deriveExecutionLimits({ budget: 500 })).toEqual({ maxTokens: 500 })
    expect(deriveExecutionLimits({ budget: 500 }).maxTokens).not.toBe(100_000)
  })

  test("supervise maxTokens equals the durable reservation and actual spend is recorded on the root", async () => {
    const sidecar = new FakeSidecar()
    let supervised: { maxTokens: number; maxTurns: number } | undefined
    const child = createChildSessionAdapter({
      session: { create: (input) => Effect.succeed({ id: input.id }), prompt: () => Effect.succeed({}) },
      execution: {
        supervise: (input) =>
          Effect.gen(function* () {
            supervised = { maxTokens: input.maxTokens, maxTurns: input.maxTurns }
            return {
              status: "budget_exhausted",
              usage: { tokens: 17, turns: 2, elapsedMs: 3 },
              artifactIds: [],
              changedPaths: [],
            }
          }),
        interrupt: () => Effect.void,
      },
    })
    const adapter = createTaskSchedulerAdapter({ scheduler: createScheduler(sidecar), worktree: worktree(), child })

    const handle = await Effect.runPromise(adapter.schedule(request))

    const childTask = sidecar.tasks.find((task) => task.task_id === handle.taskId)
    expect(childTask).toBeDefined()
    expect(supervised?.maxTokens).toBe(childTask?.budget)
    expect(supervised?.maxTokens).toBeLessThan(100_000)
    const used = sidecar.events.find((event) => event.kind.kind === "task-budget-used")
    expect(used?.kind.data).toEqual({
      root_id: handle.rootId,
      task_id: handle.rootId,
      amount: 17,
      target: "child-pool",
    })
    expect(sidecar.deliverables).toEqual([
      expect.objectContaining({ task_id: handle.taskId, status: "budget_exhausted" }),
    ])
  })
})
