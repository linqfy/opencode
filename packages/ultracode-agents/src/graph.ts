import type { Result, Task, TaskState } from "./types"

export const MAX_CHILDREN = 3
export const MAX_DEPTH = 2

export type TransitionError = "invalid_transition"
export type AdmissionError = "max_children_exceeded" | "max_depth_exceeded" | "dependencies_incomplete"
export type LeaseError = "worktree_required" | "readonly_worktree_forbidden" | "duplicate_worktree_lease"

export interface WorktreeLeaseRequest {
  readonly task: Task
  readonly worktreeId?: string
}

export interface WorktreeLease {
  readonly taskId: string
  readonly worktreeId: string
}

export function transitionTaskState(from: TaskState, to: TaskState): Result<TaskState, TransitionError> {
  if (
    (from === "pending" && (to === "running" || to === "waiting" || to === "cancelled")) ||
    (from === "waiting" && (to === "pending" || to === "cancelled")) ||
    (from === "running" && (to === "completed" || to === "failed" || to === "cancelled"))
  ) {
    return { ok: true, value: to }
  }

  return { ok: false, error: "invalid_transition" }
}

export function admitTask(candidate: Task, tasks: readonly Task[]): Result<Task, AdmissionError> {
  if (candidate.depth > MAX_DEPTH) return { ok: false, error: "max_depth_exceeded" }
  if (
    candidate.parentId !== undefined &&
    tasks.filter((task) => task.parentId === candidate.parentId).length >= MAX_CHILDREN
  ) {
    return { ok: false, error: "max_children_exceeded" }
  }
  if (!candidate.dependencyIds.every((dependencyId) => tasks.some((task) => task.taskId === dependencyId && task.state === "completed"))) {
    return { ok: false, error: "dependencies_incomplete" }
  }

  return { ok: true, value: candidate }
}

export function planWorktreeLease(
  request: WorktreeLeaseRequest,
  activeWorktreeIds: readonly string[],
): Result<WorktreeLease | undefined, LeaseError> {
  if (!request.task.stateChanging) {
    if (request.worktreeId !== undefined) return { ok: false, error: "readonly_worktree_forbidden" }
    return { ok: true, value: undefined }
  }
  if (request.worktreeId === undefined || request.worktreeId.trim() === "") {
    return { ok: false, error: "worktree_required" }
  }
  if (activeWorktreeIds.includes(request.worktreeId)) return { ok: false, error: "duplicate_worktree_lease" }

  return { ok: true, value: { taskId: request.task.taskId, worktreeId: request.worktreeId } }
}
