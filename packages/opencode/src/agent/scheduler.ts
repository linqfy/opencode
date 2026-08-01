import { Deferred, Effect, Fiber, Scope } from "effect"
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

export interface ChildSessionBoundary {
  readonly create: (input: { id: string; location: ChildLocation }) => Effect.Effect<{ id: string }>
  readonly prompt: (input: { id: string; sessionID: string; prompt: string; resume: false }) => Effect.Effect<unknown>
}

export interface ChildExecutionBoundary {
  readonly wake: (sessionID: string) => Effect.Effect<void>
  readonly interrupt: (sessionID: string) => Effect.Effect<void>
}

export interface ChildSessionInput {
  readonly rootId: string
  readonly taskId: string
  readonly location: ChildLocation
  readonly prompt: string
}

export interface ChildExecutionResult {
  readonly sessionId: string
  readonly inputId: string
}

export function createWorktreeLeaseAdapter(
  parentLocation: ChildLocation,
  worktree: Worktree.Interface,
  waitReady: (info: Worktree.Info) => Effect.Effect<void, never, Scope.Scope> = waitForReady,
) {
  const leases = new Map<string, WorktreeLease>()
  const pending = new Set<string>()

  const acquire = Effect.fn("SchedulerWorktree.acquire")(function* (input: WorktreeLeaseInput) {
    validateIdentity(input)
    if (!input.stateChanging) {
      return {
        rootId: input.rootId,
        taskId: input.taskId,
        location: parentLocation,
        write: false,
        ready: true,
      } satisfies WorktreeLease
    }

    const key = leaseKey(input)
    if (leases.has(key) || pending.has(key)) {
      return yield* Effect.fail(new Error(`worktree lease already exists for task ${input.taskId}`))
    }
    pending.add(key)

    return yield* Effect.gen(function* () {
      const info = yield* worktree.makeWorktreeInfo({ name: worktreeName(input.rootId, input.taskId) })
      const ready = yield* waitReady(info).pipe(Effect.forkScoped)
      yield* worktree.createFromInfo(info)
      yield* Fiber.join(ready)
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
      yield* input.session.create({ id: sessionId, location: child.location })
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
    if (cancelled.has(key)) return
    cancelled.add(key)
    yield* input.execution.interrupt(result.sessionId)
  })

  return { start, cancel }
}

function waitForReady(info: Worktree.Info) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const on = (event: GlobalEvent) => {
      if (event.payload.type !== Worktree.Event.Ready.type || event.payload.properties.name !== info.name) return
      Deferred.doneUnsafe(ready, Effect.void)
    }
    GlobalBus.on("event", on)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))
    yield* Deferred.await(ready)
  })
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

function encodeID(value: string) {
  return Buffer.from(value).toString("hex")
}
