import { Deferred, Effect, Scope } from "effect"
import { createScheduler } from "@ultracode/agents"
import type { TaskSchedulerAdapter } from "@/tool/task"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Worktree } from "@/worktree"

export interface ChildLocation {
  readonly directory: string
}

export interface WorktreeLeaseInput {
  readonly rootId: string
  readonly taskId: string
  readonly stateChanging: boolean
}

export interface WorktreeLease {
  readonly rootId: string
  readonly taskId: string
  readonly location: ChildLocation
  readonly write: boolean
  readonly ready: boolean
  readonly branch?: string
}

type WorktreeReadiness = (info: Worktree.Info, resolve: (result: Effect.Effect<void, Error>) => void) => () => void

export interface ChildSessionBoundary {
  readonly create: (input: {
    id: string
    location: ChildLocation
    agent: string
    model: { readonly modelID: string; readonly providerID: string }
    toolConstraints: readonly string[]
    maxTurns?: number
    forkMode: "none" | "recent" | "full"
    parent: { readonly sessionID: string; readonly messageID: string }
  }) => Effect.Effect<{ id: string }>
  readonly prompt: (input: { id: string; sessionID: string; prompt: string; resume: false }) => Effect.Effect<unknown>
}

export interface ChildExecutionBoundary {
  readonly wake: (sessionID: string) => Effect.Effect<void>
  readonly interrupt: (sessionID: string) => Effect.Effect<void | { readonly observed: boolean }>
}

export interface ChildSessionInput {
  readonly rootId: string
  readonly taskId: string
  readonly location: ChildLocation
  readonly prompt: string
  readonly agent: string
  readonly model: { readonly modelID: string; readonly providerID: string }
  readonly toolConstraints: readonly string[]
  readonly maxTurns?: number
  readonly forkMode: "none" | "recent" | "full"
  readonly parent: { readonly sessionID: string; readonly messageID: string }
}

export interface ChildExecutionResult {
  readonly sessionId: string
  readonly inputId: string
}

export interface ChildCancellation {
  readonly observed: boolean
}

export function createWorktreeLeaseAdapter(
  parentLocation: ChildLocation | (() => Effect.Effect<ChildLocation>),
  worktree: Worktree.Interface,
  watchReady: WorktreeReadiness = watchForReady,
) {
  const leases = new Map<string, WorktreeLease>()
  const pending = new Set<string>()

  const acquire = Effect.fn("SchedulerWorktree.acquire")(function* (input: WorktreeLeaseInput) {
    validateIdentity(input)
    if (!input.stateChanging) return yield* Effect.fail(new Error("scheduler children must be state-changing"))

    const key = leaseKey(input)
    if (leases.has(key) || pending.has(key)) {
      return yield* Effect.fail(new Error(`worktree lease already exists for task ${input.taskId}`))
    }
    pending.add(key)

    return yield* Effect.gen(function* () {
      const info = yield* worktree.makeWorktreeInfo({ name: worktreeName(input.rootId, input.taskId) })
      const ready = yield* Deferred.make<void, Error>()
      const stopWatching = watchReady(info, (result) => Deferred.doneUnsafe(ready, result))
      const stop = (() => {
        let stopped = false
        return () => {
          if (stopped) return
          stopped = true
          stopWatching()
        }
      })()
      yield* Effect.addFinalizer(() => Effect.sync(stop))
      yield* worktree.createFromInfo(info)
      yield* Deferred.await(ready)
      stop()
      const lease: WorktreeLease = {
        rootId: input.rootId,
        taskId: input.taskId,
        location: { directory: info.directory },
        write: true,
        ready: true,
        ...(info.branch ? { branch: info.branch } : {}),
      }
      leases.set(key, lease)
      return lease
    }).pipe(Effect.onExit(() => Effect.sync(() => pending.delete(key))))
  })

  const release = Effect.fn("SchedulerWorktree.release")(function* (
    input: Pick<WorktreeLeaseInput, "rootId" | "taskId">,
  ) {
    const key = leaseKey(input)
    const lease = leases.get(key)
    if (!lease) return yield* Effect.fail(new Error(`worktree lease not found for task ${input.taskId}`))
    yield* worktree.remove({ directory: lease.location.directory })
    leases.delete(key)
  })

  return {
    acquire,
    release,
    use: <A, E, R>(input: WorktreeLeaseInput, execute: (lease: WorktreeLease) => Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(acquire(input), execute, (lease) => (lease.write ? release(lease) : Effect.void)),
  }
}

export function createChildSessionAdapter(input: {
  readonly session: ChildSessionBoundary
  readonly execution: ChildExecutionBoundary
}) {
  const started = new Map<string, ChildExecutionResult>()
  const starting = new Set<string>()
  const cancelled = new Set<string>()

  const start = Effect.fn("SchedulerChildSession.start")(function* (child: ChildSessionInput) {
    validateIdentity(child)
    const key = leaseKey(child)
    const existing = started.get(key)
    if (existing) return existing
    if (starting.has(key))
      return yield* Effect.fail(new Error(`child session already starting for task ${child.taskId}`))
    starting.add(key)

    return yield* Effect.gen(function* () {
      const sessionId = childSessionID(child.rootId, child.taskId)
      const inputId = childInputID(child.rootId, child.taskId)
      yield* input.session.create({
        id: sessionId,
        location: child.location,
        agent: child.agent,
        model: child.model,
        toolConstraints: child.toolConstraints,
        maxTurns: child.maxTurns,
        forkMode: child.forkMode,
        parent: child.parent,
      })
      yield* input.session.prompt({ id: inputId, sessionID: sessionId, prompt: child.prompt, resume: false })
      yield* input.execution.wake(sessionId)
      const result = { sessionId, inputId } satisfies ChildExecutionResult
      started.set(key, result)
      return result
    }).pipe(Effect.onExit(() => Effect.sync(() => starting.delete(key))))
  })

  const cancel = Effect.fn("SchedulerChildSession.cancel")(function* (
    child: Pick<ChildSessionInput, "rootId" | "taskId">,
  ) {
    const key = leaseKey(child)
    const result = started.get(key)
    if (!result) return yield* Effect.fail(new Error(`child session not found for task ${child.taskId}`))
    if (cancelled.has(key)) return { observed: false } satisfies ChildCancellation
    cancelled.add(key)
    const outcome = yield* input.execution.interrupt(result.sessionId)
    return { observed: outcome !== undefined && outcome.observed } satisfies ChildCancellation
  })

  return { start, cancel }
}

/** Binds the durable scheduler to OpenCode's worktree and Session V2 boundaries. */
export function createTaskSchedulerAdapter(input: {
  readonly scheduler: ReturnType<typeof createScheduler>
  readonly worktree: ReturnType<typeof createWorktreeLeaseAdapter>
  readonly child: ReturnType<typeof createChildSessionAdapter>
}): TaskSchedulerAdapter {
  const active = new Map<
    string,
    {
      rootId: string
      lease: WorktreeLease
      handle: TaskSchedulerAdapter.Handle
    }
  >()
  return {
    schedule: (request) =>
      Effect.gen(function* () {
        const rootId = rootTaskID(request.parent.sessionID, request.parent.messageID)
        const taskId = request.requestedTaskId ?? childTaskID(rootId, request)
        const current = active.get(taskId)
        if (current) return current.handle
        const budget = request.budget.maxTokens ?? 1_000
        const rootBudget = Math.ceil(budget / 3) * 10
        yield* Effect.promise(() =>
          input.scheduler.spawn({
            key: `task:${rootId}:root:spawn`,
            task: {
              rootId,
              taskId: rootId,
              depth: 0,
              stateChanging: false,
              dependencyIds: [],
              requestedMaxTokens: rootBudget,
              requestedMaxTimeMs: request.budget.maxTimeMs ?? 0,
              forkMode: "none",
              selectedEvidenceArtifactIds: [],
              toolIds: [],
              expectedDeliverable: { name: "task-root", requiredFields: [] },
            },
            budget: { total: rootBudget, fixedCosts: 0 },
          }),
        )
        yield* Effect.promise(() =>
          input.scheduler.spawn({
            key: `task:${rootId}:${taskId}:spawn`,
            task: {
              rootId,
              taskId,
              parentId: rootId,
              depth: 1,
              stateChanging: true,
              dependencyIds: [],
              requestedMaxTokens: budget,
              requestedMaxTimeMs: request.budget.maxTimeMs ?? 0,
              forkMode: request.forkMode,
              selectedEvidenceArtifactIds: [],
              toolIds: request.agent.toolConstraints,
              expectedDeliverable: { name: "task-result", requiredFields: ["summary"] },
            },
            budget: { total: budget, fixedCosts: 0 },
          }),
        )
        yield* Effect.promise(() => input.scheduler.admit(rootId, taskId, `task:${rootId}:${taskId}:admit`))
        const scope = yield* Scope.make()
        const lease = yield* input.worktree
          .acquire({ rootId, taskId, stateChanging: true })
          .pipe(Effect.provideService(Scope.Scope, scope))
        yield* Effect.promise(() =>
          input.scheduler.leaseWorktree(
            rootId,
            taskId,
            lease.location.directory,
            `task:${rootId}:${taskId}:worktree-leased`,
          ),
        )
        yield* input.child.start({
          rootId,
          taskId,
          location: lease.location,
          prompt: request.brief,
          agent: request.agent.name,
          model: request.agent.model,
          toolConstraints: request.agent.toolConstraints,
          maxTurns: request.budget.maxTurns,
          forkMode: request.forkMode,
          parent: { sessionID: request.parent.sessionID, messageID: request.parent.messageID },
        })
        const handle = {
          rootId,
          taskId,
          status: "running",
          summary: "Task scheduled",
          evidence: { summary: "Task is running; use the task handle for status.", artifactIds: [], changedPaths: [] },
        } satisfies TaskSchedulerAdapter.Handle
        active.set(taskId, { rootId, lease, handle })
        return handle
      }),
    cancel: (request) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          input.scheduler.requestCancellation(
            request.rootId,
            request.taskId,
            request.reason,
            `task:${request.rootId}:${request.taskId}:cancel`,
          ),
        )
        const cancellation = yield* input.child.cancel({ rootId: request.rootId, taskId: request.taskId })
        if (!cancellation.observed) return { state: "cancellation_pending" } as const
        const current = active.get(request.taskId)
        if (!current?.lease.write) return { state: "cancelled" } as const
        yield* input.worktree.release({ rootId: current.rootId, taskId: request.taskId })
        yield* Effect.promise(() =>
          input.scheduler.releaseWorktree(
            current.rootId,
            request.taskId,
            current.lease.location.directory,
            `task:${current.rootId}:${request.taskId}:worktree-released`,
          ),
        )
        yield* Effect.promise(() =>
          input.scheduler.acknowledgeCancellation(
            current.rootId,
            request.taskId,
            `task:${current.rootId}:${request.taskId}:cancel-observed`,
          ),
        )
        active.delete(request.taskId)
        return { state: "cancelled" } as const
      }),
  }
}

function watchForReady(info: Worktree.Info, resolve: (result: Effect.Effect<void, Error>) => void) {
  const on = (event: GlobalEvent) => {
    if (event.directory !== info.directory) return
    if (event.payload.type === Worktree.Event.Ready.type && event.payload.properties.name === info.name) {
      resolve(Effect.void)
      return
    }
    if (event.payload.type === Worktree.Event.Failed.type)
      resolve(Effect.fail(new Error(event.payload.properties.message)))
  }
  GlobalBus.on("event", on)
  return () => GlobalBus.off("event", on)
}

function validateIdentity(input: Pick<WorktreeLeaseInput, "rootId" | "taskId">) {
  if (!input.rootId || !input.taskId || input.rootId.includes("\0") || input.taskId.includes("\0")) {
    throw new Error("rootId and taskId are required")
  }
}

function leaseKey(input: Pick<WorktreeLeaseInput, "rootId" | "taskId">) {
  return `${input.rootId}\0${input.taskId}`
}

function worktreeName(rootId: string, taskId: string) {
  return `scheduler-${encodeID(rootId)}-${encodeID(taskId)}`
}

function childSessionID(rootId: string, taskId: string) {
  return `ses_scheduler_${encodeID(rootId)}_${encodeID(taskId)}`
}

function childInputID(rootId: string, taskId: string) {
  return `msg_scheduler_${encodeID(rootId)}_${encodeID(taskId)}`
}

function rootTaskID(sessionID: string, messageID: string) {
  return `root_${encodeID(`${sessionID}\0${messageID}`)}`
}

function childTaskID(rootId: string, request: TaskSchedulerAdapter.Input) {
  return `task_${encodeID(`${rootId}\0${request.agent.name}\0${request.description}\0${request.brief}`)}`
}

function encodeID(value: string) {
  return Buffer.from(value).toString("hex")
}
