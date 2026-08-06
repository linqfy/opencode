import { describe, expect, test } from "bun:test"
import { createScheduler, UnknownTaskError, WaitTimeoutError, type SchedulerEventClient, type TaskRecord } from "../src"

type EventKind = { readonly kind: string; readonly data: Record<string, unknown> }
type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] }
type MutableTaskRecord = Mutable<TaskRecord>

class FakeEventClient implements SchedulerEventClient {
  readonly events: { key: string; kind: EventKind }[] = []
  readonly tasks: MutableTaskRecord[] = []
  readonly deliverables: {
    root_id: string
    task_id: string
    status: string
    summary: string
    artifact_ids: string[]
    changed_paths: string[]
    test_summary: string | null
  }[] = []
  listTasksCallCount = 0

  async listTasks(rootId: string, _workspaceDirectory: string, limit: number) {
    this.listTasksCallCount += 1
    return this.tasks.filter((task) => task.root_id === rootId).slice(0, limit)
  }

  async listMailbox(rootId: string, _workspaceDirectory: string, recipientTaskId: string, afterSequence: number, limit: number) {
    return []
  }

  async listTaskDeliverables(rootId: string, _workspaceDirectory: string, limit: number) {
    return this.deliverables.filter((deliverable) => deliverable.root_id === rootId).slice(0, limit)
  }

  async proposeCommit(key: string, kind: EventKind) {
    const duplicate = this.events.find((event) => event.key === key)
    if (duplicate) return { seq: this.events.indexOf(duplicate) + 1, hash: key, duplicate: true }
    const data = kind.data
    this.events.push({ key, kind })
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
    if (kind.kind === "task-state-changed") this.task(data.root_id as string, data.task_id as string).state = data.state as string
    if (kind.kind === "task-cancellation-requested") this.task(data.root_id as string, data.task_id as string).state = "cancelled"
    if (kind.kind === "task-deliverable-committed") this.deliverables.push(data as never)
    return { seq: this.events.length, hash: key, duplicate: false }
  }

  private task(rootId: string, taskId: string) {
    const task = this.tasks.find((item) => item.root_id === rootId && item.task_id === taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    return task
  }
}

function seededTask(overrides: Partial<MutableTaskRecord> = {}) {
  return {
    root_id: "root",
    task_id: "t1",
    parent_task_id: "root-task",
    depth: 1,
    state_changing: false,
    budget: 100,
    reserved_parent: 0,
    reserved_child_pool: 0,
    reserved_synthesis: 0,
    budget_used: 0,
    state: "running",
    dependencies: [],
    ...overrides,
  }
}

async function bindWorkspace(client: FakeEventClient, scheduler: ReturnType<typeof createScheduler>) {
  await scheduler.spawn({
    key: "spawn-root",
    task: {
      rootId: "root",
      workspaceDirectory: "/workspace",
      taskId: "root-task",
      depth: 0,
      stateChanging: false,
      dependencyIds: [],
      requestedMaxTokens: 1_000,
      requestedMaxTimeMs: 1_000,
      forkMode: "none",
      selectedEvidenceArtifactIds: [],
      toolIds: [],
      expectedDeliverable: { name: "result", requiredFields: ["summary"] },
    },
    budget: { total: 1_000, fixedCosts: 0 },
  })
}

describe("scheduler.waitForTasks", () => {
  test("resolves when all polled tasks reach a terminal state", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await bindWorkspace(client, scheduler)
    client.tasks.push(seededTask({ task_id: "t1", state: "running" }))
    client.tasks.push(seededTask({ task_id: "t2", state: "pending" }))

    const waiting = scheduler.waitForTasks({ rootId: "root", taskIds: ["t1", "t2"], timeoutMs: 2000, pollMs: 10 })
    await client.proposeCommit("complete-t1", {
      kind: "task-state-changed",
      data: { root_id: "root", task_id: "t1", state: "completed", reason: null },
    })
    await client.proposeCommit("deliver-t1", {
      kind: "task-deliverable-committed",
      data: { root_id: "root", task_id: "t1", status: "completed", summary: "done", artifact_ids: [], changed_paths: [], test_summary: null },
    })
    await client.proposeCommit("complete-t2", {
      kind: "task-state-changed",
      data: { root_id: "root", task_id: "t2", state: "completed", reason: null },
    })

    expect(await waiting).toEqual([
      {
        taskId: "t1",
        state: "completed",
        deliverable: { root_id: "root", task_id: "t1", status: "completed", summary: "done", artifact_ids: [], changed_paths: [], test_summary: null },
      },
      { taskId: "t2", state: "completed" },
    ])
  })

  test("rejects with WaitTimeoutError carrying pending ids when tasks never become terminal", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await bindWorkspace(client, scheduler)
    client.tasks.push(seededTask({ task_id: "t1", state: "running" }))

    await expect(scheduler.waitForTasks({ rootId: "root", taskIds: ["t1"], timeoutMs: 150, pollMs: 20 })).rejects.toMatchObject({
      _tag: "WaitTimeoutError",
      pending: ["t1"],
    })
  })

  test("rejects immediately with UnknownTaskError for unknown ids", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await bindWorkspace(client, scheduler)
    client.tasks.push(seededTask({ task_id: "t1", state: "running" }))

    const started = Date.now()
    await expect(scheduler.waitForTasks({ rootId: "root", taskIds: ["t1", "ghost"], timeoutMs: 2000, pollMs: 10 })).rejects.toBeInstanceOf(UnknownTaskError)
    expect(Date.now() - started).toBeLessThan(500)
  })

  test("treats cancelled as a terminal state", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await bindWorkspace(client, scheduler)
    client.tasks.push(seededTask({ task_id: "t1", state: "running" }))

    const waiting = scheduler.waitForTasks({ rootId: "root", taskIds: ["t1"], timeoutMs: 2000, pollMs: 10 })
    await client.proposeCommit("cancel-t1", {
      kind: "task-cancellation-requested",
      data: { root_id: "root", task_id: "t1", reason: "user stopped" },
    })

    expect(await waiting).toEqual([{ taskId: "t1", state: "cancelled" }])
  })

  test("grows the poll interval across polls so listTasks stays bounded", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await bindWorkspace(client, scheduler)
    client.tasks.push(seededTask({ task_id: "t1", state: "running" }))
    const baseline = client.listTasksCallCount

    await expect(scheduler.waitForTasks({ rootId: "root", taskIds: ["t1"], timeoutMs: 300, pollMs: 5 })).rejects.toMatchObject({
      _tag: "WaitTimeoutError",
    })

    const polls = client.listTasksCallCount - baseline
    expect(polls).toBeGreaterThanOrEqual(3)
    expect(polls).toBeLessThan(30)
  })
})
