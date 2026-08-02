import { describe, expect, test } from "bun:test"
import { createScheduler, type SchedulerEventClient, type TaskRecord } from "../src"

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

  async listTasks(rootId: string, limit: number) {
    return this.tasks.filter((task) => task.root_id === rootId).slice(0, limit)
  }

  async listMailbox(rootId: string, recipientTaskId: string, afterSequence: number, limit: number) {
    return this.mailbox
      .filter((message) => message.root_id === rootId && message.recipient_task_id === recipientTaskId && message.sequence > afterSequence)
      .slice(0, limit)
  }

  async listTaskDeliverables(rootId: string, limit: number) {
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

function spawnInput(overrides: Record<string, unknown> = {}) {
  return {
    key: "spawn-root",
    task: {
      rootId: "root",
      taskId: "root-task",
      depth: 0,
      stateChanging: false,
      dependencyIds: [],
      requestedMaxTokens: 1_000,
      requestedMaxTimeMs: 1_000,
      forkMode: "none" as const,
      selectedEvidenceArtifactIds: [],
      toolIds: [],
      expectedDeliverable: { name: "result", requiredFields: ["summary"] },
    },
    budget: { total: 1_000, fixedCosts: 0 },
    ...overrides,
  }
}

describe("sidecar-backed scheduler", () => {
  test("spawns idempotently through durable events without executing children", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)

    await scheduler.spawn(spawnInput())
    await scheduler.spawn(spawnInput())

    expect(client.events).toEqual([
      expect.objectContaining({ key: "spawn-root", kind: expect.objectContaining({ kind: "task-spawned" }) }),
      expect.objectContaining({ key: "spawn-root:budget", kind: expect.objectContaining({ kind: "task-budget-reserved" }) }),
    ])
  })

  test("admits a new child from child-pool capacity reclaimed by a terminal sibling", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await scheduler.spawn(spawnInput({ budget: { total: 100, fixedCosts: 0 } }))
    await scheduler.spawn(spawnInput({ key: "child-a", task: { ...spawnInput().task, taskId: "child-a", parentId: "root-task", depth: 1 }, budget: { total: 20, fixedCosts: 0 } }))
    await scheduler.admit("root", "child-a", "admit-child-a")
    await scheduler.commitDeliverable({ rootId: "root", taskId: "child-a", stateKey: "finish-child-a", deliverableKey: "deliver-child-a", status: "completed", manifest: { summary: "done", artifactIds: [], changedPaths: [] } })
    await scheduler.reclaimChildBudget({ key: "reclaim-child-a", rootId: "root", taskId: "child-a", amount: 10 })

    await expect(scheduler.spawn(spawnInput({ key: "child-b", task: { ...spawnInput().task, taskId: "child-b", parentId: "root-task", depth: 1 }, budget: { total: 20, fixedCosts: 0 } }))).resolves.toEqual({ rootId: "root", taskId: "child-b" })
  })

  test("rejects invalid child graph, dependencies, and budget before committing", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await scheduler.spawn(spawnInput({ budget: { total: 1_000, fixedCosts: 0 } }))

    await expect(
      scheduler.spawn(spawnInput({ key: "too-deep", task: { ...spawnInput().task, taskId: "deep", parentId: "root-task", depth: 3 } })),
    ).rejects.toThrow("max_depth_exceeded")
    await expect(
      scheduler.spawn(
        spawnInput({
          key: "blocked",
          task: { ...spawnInput().task, taskId: "blocked", parentId: "root-task", depth: 1, dependencyIds: ["missing"] },
          budget: { total: 100, fixedCosts: 0 },
        }),
      ),
    ).rejects.toThrow("dependency_not_found")
    await expect(scheduler.spawn(spawnInput({ key: "bad-budget", budget: { total: 101, fixedCosts: 0 } }))).rejects.toThrow(
      "non_integral_allocation",
    )
    expect(client.events).toHaveLength(2)
  })

  test("admits a pending task only after all dependencies complete", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await scheduler.spawn(spawnInput())
    await scheduler.spawn(
      spawnInput({ key: "spawn-dependent", task: { ...spawnInput().task, taskId: "dependent", dependencyIds: ["root-task"] } }),
    )

    await expect(scheduler.admit("root", "dependent", "admit-dependent")).rejects.toThrow("dependencies_incomplete")
    await client.proposeCommit("complete-root", {
      kind: "task-state-changed",
      data: { root_id: "root", task_id: "root-task", state: "running", reason: null },
    })
    await client.proposeCommit("finish-root", {
      kind: "task-state-changed",
      data: { root_id: "root", task_id: "root-task", state: "completed", reason: null },
    })

    await scheduler.admit("root", "dependent", "admit-dependent")

    expect(client.events.at(-1)).toEqual({
      key: "admit-dependent",
      kind: { kind: "task-state-changed", data: { root_id: "root", task_id: "dependent", state: "running", reason: null } },
    })
  })

  test("records cancellation request before a durable acknowledgement without local authority", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await scheduler.spawn(spawnInput())

    await expect(scheduler.acknowledgeCancellation("root", "root-task", "cancel-observed")).rejects.toThrow("not cancelled")
    await scheduler.requestCancellation("root", "root-task", "user stopped", "cancel-request")
    await scheduler.acknowledgeCancellation("root", "root-task", "cancel-observed")

    expect(client.events.slice(-2).map((event) => event.kind.kind)).toEqual(["task-cancellation-requested", "task-cancellation-observed"])
  })

  test("sends sequential recipient-scoped evidence without transcript input and acknowledges it", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await scheduler.spawn(spawnInput())
    await scheduler.spawn(spawnInput({ key: "spawn-recipient", task: { ...spawnInput().task, taskId: "recipient" } }))

    await scheduler.sendMailbox({
      key: "message-one",
      rootId: "root",
      messageId: "message-one",
      senderTaskId: "root-task",
      recipientTaskId: "recipient",
      evidence: { summary: "first result", artifactIds: ["artifact-a"], changedPaths: ["src/a.ts"], testSummary: "pass" },
    })
    await scheduler.sendMailbox({
      key: "message-two",
      rootId: "root",
      messageId: "message-two",
      senderTaskId: "root-task",
      recipientTaskId: "recipient",
      evidence: { summary: "second result", artifactIds: ["artifact-b"], changedPaths: [] },
    })
    await expect(
      scheduler.sendMailbox({
        key: "transcript",
        rootId: "root",
        messageId: "transcript",
        senderTaskId: "root-task",
        recipientTaskId: "recipient",
        evidence: { summary: "no", artifactIds: [], changedPaths: [], transcript: "secret child history" } as never,
      }),
    ).rejects.toThrow("transcript")
    await scheduler.acknowledgeMailbox("root", "message-two", "recipient", "ack-message-two")

    expect(client.mailbox.map((message) => message.sequence)).toEqual([1, 2])
    expect(client.events.find((event) => event.key === "message-one")?.kind).toEqual({
      kind: "mailbox-message-sent",
      data: {
        root_id: "root",
        message_id: "message-one",
        sender_task_id: "root-task",
        recipient_task_id: "recipient",
        sequence: 1,
        summary: "first result",
        artifact_ids: ["artifact-a"],
        changed_paths: ["src/a.ts"],
        test_summary: "pass",
        blocked_reason: null,
      },
    })
    expect(client.mailbox[1]?.acknowledged).toBe(true)
  })

  test("allocates mailbox sequence after every bounded sidecar page", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await scheduler.spawn(spawnInput())
    await scheduler.spawn(spawnInput({ key: "spawn-recipient", task: { ...spawnInput().task, taskId: "recipient" } }))
    client.mailbox.push(
      ...Array.from({ length: 101 }, (_, index) => ({
        root_id: "root",
        message_id: `prior-${index + 1}`,
        sender_task_id: "root-task",
        recipient_task_id: "recipient",
        sequence: index + 1,
        summary: "prior",
        artifact_ids: [],
        changed_paths: [],
        test_summary: null,
        blocked_reason: null,
        acknowledged: false,
      })),
    )

    await scheduler.sendMailbox({
      key: "message-after-page",
      rootId: "root",
      messageId: "message-after-page",
      senderTaskId: "root-task",
      recipientTaskId: "recipient",
      evidence: { summary: "paged", artifactIds: [], changedPaths: [] },
    })

    expect(client.mailbox.at(-1)?.sequence).toBe(102)
  })

  test("commits a valid terminal deliverable with separate state and deliverable keys", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await scheduler.spawn(spawnInput())
    await scheduler.admit("root", "root-task", "admit-root")

    await scheduler.commitDeliverable({
      rootId: "root",
      taskId: "root-task",
      stateKey: "complete-root",
      deliverableKey: "deliver-root",
      status: "completed",
      manifest: { summary: "implemented", artifactIds: ["artifact-result"], changedPaths: ["src/scheduler.ts"], testSummary: "bun test" },
    })

    expect(client.events.slice(-2).map((event) => event.key)).toEqual(["complete-root", "deliver-root"])
    expect(client.deliverables).toEqual([
      {
        root_id: "root",
        task_id: "root-task",
        status: "completed",
        summary: "implemented",
        artifact_ids: ["artifact-result"],
        changed_paths: ["src/scheduler.ts"],
        test_summary: "bun test",
      },
    ])
  })

  test("repairs a missing deliverable for an already matching terminal task without repeating its state transition", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await scheduler.spawn(spawnInput())
    await scheduler.admit("root", "root-task", "admit-root")
    await client.proposeCommit("terminal-root", {
      kind: "task-state-changed",
      data: { root_id: "root", task_id: "root-task", state: "completed", reason: null },
    })

    await scheduler.commitDeliverable({
      rootId: "root",
      taskId: "root-task",
      stateKey: "must-not-be-used",
      deliverableKey: "repair-deliverable",
      status: "completed",
      manifest: { summary: "recovered", artifactIds: [], changedPaths: [] },
    })

    expect(client.events.map((event) => event.key)).not.toContain("must-not-be-used")
    expect(client.events.at(-1)).toEqual(expect.objectContaining({ key: "repair-deliverable" }))
    await scheduler.commitDeliverable({
      rootId: "root",
      taskId: "root-task",
      stateKey: "must-not-be-used-again",
      deliverableKey: "repair-deliverable-again",
      status: "completed",
      manifest: { summary: "recovered", artifactIds: [], changedPaths: [] },
    })
    expect(client.events.map((event) => event.key)).not.toContain("must-not-be-used-again")
    expect(client.events.map((event) => event.key)).not.toContain("repair-deliverable-again")
  })

  test("rejects nonterminal and oversized deliverables before committing", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await scheduler.spawn(spawnInput())
    const eventsBefore = client.events.length

    await expect(
      scheduler.commitDeliverable({
        rootId: "root",
        taskId: "root-task",
        stateKey: "state",
        deliverableKey: "deliverable",
        status: "running" as never,
        manifest: { summary: "not done", artifactIds: [], changedPaths: [] },
      }),
    ).rejects.toThrow("terminal")
    await expect(
      scheduler.commitDeliverable({
        rootId: "root",
        taskId: "root-task",
        stateKey: "state-too-long",
        deliverableKey: "deliverable-too-long",
        status: "completed",
        manifest: { summary: "x".repeat(4_097), artifactIds: [], changedPaths: [] },
      }),
    ).rejects.toThrow("summary")
    await expect(
      scheduler.commitDeliverable({
        rootId: "root",
        taskId: "root-task",
        stateKey: "state-oversized-bytes",
        deliverableKey: "deliverable-oversized-bytes",
        status: "completed",
        manifest: { summary: "€".repeat(1_366), artifactIds: [], changedPaths: [] },
      }),
    ).rejects.toThrow("summary")
    expect(client.events).toHaveLength(eventsBefore)
  })

  test("propagates sidecar commit failures without retaining local state", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    client.failNextCommit = true

    await expect(scheduler.spawn(spawnInput())).rejects.toThrow("sidecar unavailable")
    expect(await client.listTasks("root", 100)).toEqual([])
    await scheduler.spawn(spawnInput())
    expect(client.events).toHaveLength(2)
  })

  test("returns bounded evidence views without transcript data", async () => {
    const client = new FakeEventClient()
    const scheduler = createScheduler(client)
    await scheduler.spawn(spawnInput())
    await scheduler.spawn(spawnInput({ key: "spawn-recipient", task: { ...spawnInput().task, taskId: "recipient" } }))
    await scheduler.sendMailbox({
      key: "message",
      rootId: "root",
      messageId: "message",
      senderTaskId: "root-task",
      recipientTaskId: "recipient",
      evidence: { summary: "evidence", artifactIds: [], changedPaths: [] },
    })

    expect(await scheduler.listEvidence({ rootId: "root", recipientTaskId: "recipient", limit: 1 })).toEqual({
      mailbox: [expect.objectContaining({
        message_id: "message",
        summary: "evidence",
        artifact_ids: [],
        changed_paths: [],
        test_summary: null,
        blocked_reason: null,
      })],
      deliverables: [],
    })
  })
})
