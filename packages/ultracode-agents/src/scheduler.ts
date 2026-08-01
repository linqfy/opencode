import { createBudget, type BudgetInput } from "./budget"
import type { MailboxMessage, SchedulerEventClient, TaskDeliverable, TaskRecord } from "./events-client"
import { MAX_CHILDREN, MAX_DEPTH, admitTask, transitionTaskState } from "./graph"
import type { Task, TaskInput, TaskState } from "./types"

const EVIDENCE_LIMIT = 100
const MAX_SUMMARY_LENGTH = 4_096
const MAX_ARTIFACT_IDS = 100
const MAX_CHANGED_PATHS = 100

export interface EvidenceManifest {
  readonly summary: string
  readonly artifactIds: readonly string[]
  readonly changedPaths: readonly string[]
  readonly testSummary?: string
  readonly blockedReason?: string
}

export interface SpawnInput {
  readonly key: string
  readonly task: TaskInput
  readonly budget: BudgetInput
}

export interface MailboxInput {
  readonly key: string
  readonly rootId: string
  readonly messageId: string
  readonly senderTaskId: string
  readonly recipientTaskId: string
  readonly evidence: EvidenceManifest
}

export interface DeliverableInput {
  readonly rootId: string
  readonly taskId: string
  readonly stateKey: string
  readonly deliverableKey: string
  readonly status: "completed" | "failed" | "cancelled"
  readonly manifest: EvidenceManifest
}

export interface EvidenceQuery {
  readonly rootId: string
  readonly recipientTaskId: string
  readonly afterSequence?: number
  readonly limit?: number
}

export function createScheduler(client: SchedulerEventClient) {
  return {
    spawn: async (input: SpawnInput) => {
      const budget = createBudget(input.budget)
      if (!budget.ok) throw new Error(budget.error)
      const tasks = await client.listTasks(input.task.rootId, 100)
      validateSpawn(input, tasks)
      const existing = tasks.find((task) => task.task_id === input.task.taskId)
      if (!existing) {
        await client.proposeCommit(input.key, {
          kind: "task-spawned",
          data: {
            root_id: input.task.rootId,
            task_id: input.task.taskId,
            parent_task_id: input.task.parentId ?? null,
            depth: input.task.depth,
            state_changing: input.task.stateChanging,
            dependencies: [...input.task.dependencyIds],
            budget: input.budget.total,
          },
        })
      }
      if (existing && (existing.reserved_parent !== 0 || existing.reserved_child_pool !== 0 || existing.reserved_synthesis !== 0)) {
        return { rootId: input.task.rootId, taskId: input.task.taskId }
      }
      await client.proposeCommit(`${input.key}:budget`, {
        kind: "task-budget-reserved",
        data: {
          root_id: input.task.rootId,
          task_id: input.task.taskId,
          parent: budget.value.parentAllocation,
          child_pool: budget.value.childPoolAllocation,
          synthesis: budget.value.synthesisReserve,
        },
      })
      return { rootId: input.task.rootId, taskId: input.task.taskId }
    },
    admit: async (rootId: string, taskId: string, key: string) => {
      const tasks = await client.listTasks(rootId, EVIDENCE_LIMIT)
      const candidate = tasks.find((task) => task.task_id === taskId)
      if (!candidate) throw new Error(`unknown task: ${taskId}`)
      if (candidate.state !== "pending") throw new Error("invalid_transition")
      const admission = admitTask(toTask(candidate), tasks.filter((task) => task.task_id !== taskId).map(toTask))
      if (!admission.ok) throw new Error(admission.error)
      await client.proposeCommit(key, stateChanged(rootId, taskId, "running"))
    },
    requestCancellation: async (rootId: string, taskId: string, reason: string, key: string) => {
      await client.proposeCommit(key, {
        kind: "task-cancellation-requested",
        data: { root_id: rootId, task_id: taskId, reason },
      })
    },
    acknowledgeCancellation: async (rootId: string, taskId: string, key: string) => {
      await client.proposeCommit(key, {
        kind: "task-cancellation-observed",
        data: { root_id: rootId, task_id: taskId },
      })
    },
    sendMailbox: async (input: MailboxInput) => {
      validateEvidence(input.evidence)
      const sequence = (await currentMailboxSequence(client, input.rootId, input.recipientTaskId)) + 1
      await client.proposeCommit(input.key, {
        kind: "mailbox-message-sent",
        data: {
          root_id: input.rootId,
          message_id: input.messageId,
          sender_task_id: input.senderTaskId,
          recipient_task_id: input.recipientTaskId,
          sequence,
          artifact_ids: [...input.evidence.artifactIds],
        },
      })
    },
    acknowledgeMailbox: async (rootId: string, messageId: string, recipientTaskId: string, key: string) => {
      await client.proposeCommit(key, {
        kind: "mailbox-message-acknowledged",
        data: { root_id: rootId, message_id: messageId, recipient_task_id: recipientTaskId },
      })
    },
    commitDeliverable: async (input: DeliverableInput) => {
      validateEvidence(input.manifest)
      const tasks = await client.listTasks(input.rootId, EVIDENCE_LIMIT)
      const task = tasks.find((candidate) => candidate.task_id === input.taskId)
      if (!task) throw new Error(`unknown task: ${input.taskId}`)
      if (!isTerminal(input.status)) throw new Error("terminal state required")
      if (transitionTaskState(task.state as TaskState, input.status).ok === false) throw new Error("terminal state required")
      await client.proposeCommit(input.stateKey, stateChanged(input.rootId, input.taskId, input.status, input.manifest.blockedReason))
      await client.proposeCommit(input.deliverableKey, {
        kind: "task-deliverable-committed",
        data: {
          root_id: input.rootId,
          task_id: input.taskId,
          status: input.status,
          summary: input.manifest.summary,
          artifact_ids: [...input.manifest.artifactIds],
          changed_paths: [...input.manifest.changedPaths],
          test_summary: input.manifest.testSummary ?? null,
        },
      })
    },
    listEvidence: async (input: EvidenceQuery): Promise<{ mailbox: readonly MailboxMessage[]; deliverables: readonly TaskDeliverable[] }> => {
      const limit = boundedLimit(input.limit)
      return {
        mailbox: await client.listMailbox(input.rootId, input.recipientTaskId, input.afterSequence ?? 0, limit),
        deliverables: await client.listTaskDeliverables(input.rootId, limit),
      }
    },
  }
}

function validateSpawn(input: SpawnInput, tasks: readonly TaskRecord[]) {
  if (input.task.depth > MAX_DEPTH) throw new Error("max_depth_exceeded")
  if (tasks.some((task) => task.task_id === input.task.taskId)) return
  if (input.task.parentId === undefined) {
    if (input.task.depth !== 0) throw new Error("invalid_parent_depth")
  } else {
    const parent = tasks.find((task) => task.task_id === input.task.parentId)
    if (!parent) throw new Error("parent_not_found")
    if (input.task.depth !== parent.depth + 1) throw new Error("invalid_parent_depth")
    if (tasks.filter((task) => task.parent_task_id === input.task.parentId).length >= MAX_CHILDREN) throw new Error("max_children_exceeded")
    const childBudget = tasks
      .filter((task) => task.parent_task_id === input.task.parentId)
      .reduce((total, task) => total + task.budget, input.budget.total)
    if (childBudget > parent.reserved_child_pool - parent.budget_used) throw new Error("child_budget_exhausted")
  }
  if (!input.task.dependencyIds.every((dependency) => tasks.some((task) => task.task_id === dependency))) {
    throw new Error("dependency_not_found")
  }
}

function validateEvidence(evidence: EvidenceManifest) {
  const keys = Object.keys(evidence)
  if (keys.includes("transcript")) throw new Error("transcript evidence is not accepted")
  if (!keys.every((key) => ["summary", "artifactIds", "changedPaths", "testSummary", "blockedReason"].includes(key))) {
    throw new Error("invalid evidence field")
  }
  if (typeof evidence.summary !== "string" || evidence.summary.length > MAX_SUMMARY_LENGTH) throw new Error("invalid evidence summary")
  if (!validStrings(evidence.artifactIds, MAX_ARTIFACT_IDS) || !validStrings(evidence.changedPaths, MAX_CHANGED_PATHS)) {
    throw new Error("invalid evidence references")
  }
  if (evidence.testSummary !== undefined && (typeof evidence.testSummary !== "string" || evidence.testSummary.length > MAX_SUMMARY_LENGTH)) {
    throw new Error("invalid test summary")
  }
  if (evidence.blockedReason !== undefined && (typeof evidence.blockedReason !== "string" || evidence.blockedReason.length > MAX_SUMMARY_LENGTH)) {
    throw new Error("invalid blocked reason")
  }
}

function validStrings(values: readonly string[], max: number) {
  return Array.isArray(values) && values.length <= max && values.every((value) => typeof value === "string" && value.length > 0 && value.length <= 1_024)
}

function boundedLimit(limit: number | undefined) {
  if (limit === undefined) return EVIDENCE_LIMIT
  if (!Number.isInteger(limit) || limit < 1) throw new Error("invalid evidence limit")
  return Math.min(limit, EVIDENCE_LIMIT)
}

async function currentMailboxSequence(client: SchedulerEventClient, rootId: string, recipientTaskId: string) {
  let afterSequence = 0
  while (true) {
    const messages = await client.listMailbox(rootId, recipientTaskId, afterSequence, EVIDENCE_LIMIT)
    if (messages.length === 0) return afterSequence
    const sequence = Math.max(afterSequence, ...messages.map((message) => message.sequence))
    if (messages.length < EVIDENCE_LIMIT) return sequence
    afterSequence = sequence
  }
}

function stateChanged(rootId: string, taskId: string, state: TaskState, reason: string | undefined = undefined) {
  return {
    kind: "task-state-changed",
    data: { root_id: rootId, task_id: taskId, state, reason: reason ?? null },
  }
}

function isTerminal(state: TaskState): state is "completed" | "failed" | "cancelled" {
  return state === "completed" || state === "failed" || state === "cancelled"
}

function toTask(task: TaskRecord): Task {
  return {
    rootId: task.root_id,
    taskId: task.task_id,
    ...(task.parent_task_id === null ? {} : { parentId: task.parent_task_id }),
    depth: task.depth,
    state: task.state as Task["state"],
    stateChanging: task.state_changing,
    dependencyIds: task.dependencies,
    requestedMaxTokens: task.budget,
    requestedMaxTimeMs: 0,
    forkMode: "none",
    selectedEvidenceArtifactIds: [],
    toolIds: [],
    expectedDeliverable: { name: "durable-task", requiredFields: [] },
  }
}
