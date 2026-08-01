import { describe, expect, test } from "bun:test"
import {
  MAX_CHILDREN,
  MAX_DEPTH,
  admitTask,
  planWorktreeLease,
  transitionTaskState,
  type Task,
} from "../src"

function task(overrides: Partial<Task> = {}): Task {
  return {
    rootId: "root",
    taskId: "task",
    depth: 0,
    state: "pending",
    stateChanging: false,
    dependencyIds: [],
    requestedMaxTokens: 100,
    requestedMaxTimeMs: 1_000,
    forkMode: "none",
    selectedEvidenceArtifactIds: [],
    toolIds: [],
    expectedDeliverable: { name: "result", requiredFields: ["summary"] },
    ...overrides,
  }
}

describe("task state transitions", () => {
  test("permits only the declared non-terminal transitions", () => {
    expect(transitionTaskState("pending", "running")).toEqual({ ok: true, value: "running" })
    expect(transitionTaskState("pending", "waiting")).toEqual({ ok: true, value: "waiting" })
    expect(transitionTaskState("pending", "cancelled")).toEqual({ ok: true, value: "cancelled" })
    expect(transitionTaskState("waiting", "pending")).toEqual({ ok: true, value: "pending" })
    expect(transitionTaskState("waiting", "cancelled")).toEqual({ ok: true, value: "cancelled" })
    expect(transitionTaskState("running", "completed")).toEqual({ ok: true, value: "completed" })
    expect(transitionTaskState("running", "failed")).toEqual({ ok: true, value: "failed" })
    expect(transitionTaskState("running", "cancelled")).toEqual({ ok: true, value: "cancelled" })
    expect(transitionTaskState("pending", "completed")).toEqual({ ok: false, error: "invalid_transition" })
    expect(transitionTaskState("waiting", "running")).toEqual({ ok: false, error: "invalid_transition" })
    expect(transitionTaskState("running", "waiting")).toEqual({ ok: false, error: "invalid_transition" })
  })

  test("never transitions terminal states", () => {
    expect(transitionTaskState("completed", "running")).toEqual({ ok: false, error: "invalid_transition" })
    expect(transitionTaskState("failed", "pending")).toEqual({ ok: false, error: "invalid_transition" })
    expect(transitionTaskState("cancelled", "waiting")).toEqual({ ok: false, error: "invalid_transition" })
  })
})

describe("task admission", () => {
  test("exposes the scheduler child and depth constraints", () => {
    expect(MAX_CHILDREN).toBe(3)
    expect(MAX_DEPTH).toBe(2)
  })

  test("rejects a fourth direct child", () => {
    const parent = task({ taskId: "parent" })
    const children = ["one", "two", "three"].map((taskId) => task({ taskId, parentId: parent.taskId, depth: 1 }))

    expect(admitTask(task({ taskId: "four", parentId: parent.taskId, depth: 1 }), [parent, ...children])).toEqual({
      ok: false,
      error: "max_children_exceeded",
    })
  })

  test("rejects tasks deeper than two", () => {
    expect(admitTask(task({ depth: 3 }), [])).toEqual({ ok: false, error: "max_depth_exceeded" })
  })

  test("requires every dependency to be completed before admission", () => {
    const dependency = task({ taskId: "dependency", state: "running" })

    expect(admitTask(task({ dependencyIds: [dependency.taskId] }), [dependency])).toEqual({
      ok: false,
      error: "dependencies_incomplete",
    })
    expect(admitTask(task({ dependencyIds: [dependency.taskId] }), [{ ...dependency, state: "completed" }])).toEqual({
      ok: true,
      value: task({ dependencyIds: [dependency.taskId] }),
    })
  })

  test("does not mutate frozen tasks during admission", () => {
    const candidate = Object.freeze(task({ dependencyIds: Object.freeze(["dependency"]) }))
    const dependency = Object.freeze(task({ taskId: "dependency", state: "completed" }))

    admitTask(candidate, Object.freeze([dependency]))

    expect(candidate.state).toBe("pending")
    expect(dependency.state).toBe("completed")
  })
})

describe("worktree leases", () => {
  test("requires each state-changing child to hold a nonempty unique worktree lease", () => {
    const child = task({ taskId: "writer", parentId: "parent", depth: 1, stateChanging: true })

    expect(planWorktreeLease({ task: child, worktreeId: "" }, [])).toEqual({ ok: false, error: "worktree_required" })
    expect(planWorktreeLease({ task: child, worktreeId: "worktree-a" }, ["worktree-a"])).toEqual({
      ok: false,
      error: "duplicate_worktree_lease",
    })
    expect(planWorktreeLease({ task: child, worktreeId: "worktree-a" }, [])).toEqual({
      ok: true,
      value: { taskId: "writer", worktreeId: "worktree-a" },
    })
  })

  test("requires read-only children to have no worktree lease", () => {
    const child = task({ taskId: "reader", parentId: "parent", depth: 1 })

    expect(planWorktreeLease({ task: child, worktreeId: "worktree-a" }, [])).toEqual({
      ok: false,
      error: "readonly_worktree_forbidden",
    })
    expect(planWorktreeLease({ task: child }, [])).toEqual({ ok: true, value: undefined })
  })
})
