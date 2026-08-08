import { describe, expect, test } from "bun:test"
import { createScheduler, type SchedulerEventClient, type TaskRecord } from "../src"
import { transitionTaskState } from "../src/graph"

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
  failNextCommit = false

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

  async proposeCommit(key: string, kind: EventKind) {
    const duplicate = this.events.find((event) => event.key === key)
    if (duplicate) return { seq: this.events.indexOf(duplicate) + 1, hash: key, duplicate: true }
    if (this.failNextCommit) {
      this.failNextCommit = false
      throw new Error("sidecar unavailable")
    }
    const data = kind.data
    if (kind.kind === "task-cancellation-observed" && this.task(data.root_id as string, data.task_id as string).state !== "cancelled") {
      throw new Error("task is not cancelled")
    }
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
    if (kind.kind === "mailbox-message-acknowledged") {
      const message = this.mailbox.find((item) => item.root_id === data.root_id && item.message_id === data.message_id)
      if (message?.recipient_task_id !== data.recipient_task_id) throw new Error("mailbox acknowledgement recipient mismatch")
      if (message) message.acknowledged = true
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

const task = (overrides: Partial<TaskRecord>): TaskRecord => ({
  root_id: "root",
  task_id: "child-a",
  parent_task_id: "root-task",
  depth: 1,
  state_changing: true,
  budget: 250,
  reserved_parent: 150,
  reserved_child_pool: 75,
  reserved_synthesis: 25,
  budget_used: 0,
  budget_reclaimed: 0,
  state: "pending",
  dependencies: [],
  ...overrides,
})

describe("budget_exhausted terminal state", () => {
  test("running -> budget_exhausted is a legal terminal transition", () => {
    expect(transitionTaskState("running", "budget_exhausted")).toEqual({ ok: true, value: "budget_exhausted" })
  })

  test("budget_exhausted is not a legal transition from pending", () => {
    expect(transitionTaskState("pending", "budget_exhausted")).toEqual({ ok: false, error: "invalid_transition" })
  })

  test("commitDeliverable accepts budget_exhausted as a terminal deliverable status", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
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
    client.tasks.push(task({ state: "budget_exhausted" }))
    await scheduler.commitDeliverable({
      rootId: "root",
      taskId: "child-a",
      stateKey: "state-key",
      deliverableKey: "deliverable-key",
      status: "budget_exhausted",
      manifest: { summary: "child pool depleted", artifactIds: [], changedPaths: [] },
    })
    expect(client.deliverables[0]?.status).toBe("budget_exhausted")
  })

  test("validateSpawn ignores terminal children and budgets against the parent's recorded spend", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await scheduler.spawn({
      key: "spawn-ws",
      task: {
        rootId: "root",
        workspaceDirectory: "/workspace",
        taskId: "ws-root",
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
    client.tasks.push(
      task({ task_id: "root-task", depth: 0, parent_task_id: null, state_changing: false, budget: 1000, reserved_parent: 600, reserved_child_pool: 300, reserved_synthesis: 100, budget_used: 100, state: "running" }),
      task({ task_id: "child-a", budget: 250, budget_used: 0, budget_reclaimed: 150, state: "budget_exhausted" }),
    )
    await expect(
      scheduler.spawn({
        key: "spawn-child-b",
        task: {
          rootId: "root",
          taskId: "child-b",
          parentId: "root-task",
          depth: 1,
          stateChanging: true,
          dependencyIds: [],
          requestedMaxTokens: 150,
          requestedMaxTimeMs: 1000,
          forkMode: "none",
          selectedEvidenceArtifactIds: [],
          toolIds: [],
          expectedDeliverable: { name: "task-result", requiredFields: ["summary"] },
        },
        budget: { total: 150, fixedCosts: 0 },
      }),
    ).resolves.toEqual({ rootId: "root", taskId: "child-b" })
  })
})
