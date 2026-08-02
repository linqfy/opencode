import { Cause, Deferred, Effect, Exit, Scope } from "effect"
import { createScheduler } from "@ultracode/agents"
import type { SessionExecution } from "@opencode-ai/core/session/execution"
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
  readonly supervise: (input: {
    readonly sessionID: string
    readonly maxTokens: number
    readonly maxTurns: number
    readonly timeoutMs: number
  }) => Effect.Effect<SessionExecution.TerminalRunResult, Error>
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
  readonly maxTurns: number
  readonly maxTokens: number
  readonly timeoutMs: number
  readonly forkMode: "none" | "recent" | "full"
  readonly parent: { readonly sessionID: string; readonly messageID: string }
}

export interface ChildExecutionResult {
  readonly sessionId: string
  readonly inputId: string
  readonly terminal: SessionExecution.TerminalRunResult
}

export interface ChildSessionHandle {
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
  const released = new Set<string>()

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
      released.delete(key)
      leases.set(key, lease)
      return lease
    }).pipe(Effect.onExit(() => Effect.sync(() => pending.delete(key))))
  })

  const release = Effect.fn("SchedulerWorktree.release")(function* (
    input: Pick<WorktreeLeaseInput, "rootId" | "taskId">,
  ) {
    const key = leaseKey(input)
    const lease = leases.get(key)
    if (!lease && released.has(key)) return
    if (!lease) return yield* Effect.fail(new Error(`worktree lease not found for task ${input.taskId}`))
    yield* worktree.remove({ directory: lease.location.directory })
    leases.delete(key)
    released.add(key)
  })

  const recover = Effect.fn("SchedulerWorktree.recover")(function* (input: WorktreeLeaseInput) {
    validateIdentity(input)
    const key = leaseKey(input)
    const existing = leases.get(key)
    if (existing) return existing
    const info = (yield* worktree.list()).find((candidate) => candidate.name === worktreeName(input.rootId, input.taskId))
    if (!info) return yield* Effect.fail(new Error(`worktree lease cannot be recovered for task ${input.taskId}`))
    const lease: WorktreeLease = {
      rootId: input.rootId,
      taskId: input.taskId,
      location: { directory: info.directory },
      write: true,
      ready: true,
      ...(info.branch ? { branch: info.branch } : {}),
    }
    released.delete(key)
    leases.set(key, lease)
    return lease
  })

  return {
    acquire,
    recover,
    release,
    use: <A, E, R>(input: WorktreeLeaseInput, execute: (lease: WorktreeLease) => Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(acquire(input), execute, (lease) => (lease.write ? release(lease) : Effect.void)),
  }
}

export function createChildSessionAdapter(input: {
  readonly session: ChildSessionBoundary
  readonly execution: ChildExecutionBoundary
}) {
  const started = new Map<string, ChildSessionHandle>()
  const finished = new Map<string, ChildExecutionResult>()
  const starting = new Set<string>()
  const cancelled = new Set<string>()

  const begin = Effect.fn("SchedulerChildSession.begin")(function* (child: ChildSessionInput) {
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
      if (cancelled.has(key)) return { sessionId, inputId } satisfies ChildSessionHandle
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
      const result = { sessionId, inputId } satisfies ChildSessionHandle
      started.set(key, result)
      return result
    }).pipe(Effect.onExit(() => Effect.sync(() => starting.delete(key))))
  })

  const supervise = Effect.fn("SchedulerChildSession.supervise")(function* (child: ChildSessionInput) {
    const key = leaseKey(child)
    const previous = finished.get(key)
    if (previous) return previous
    const startedChild = yield* begin(child)
    if (cancelled.has(key)) {
      const result = {
        ...startedChild,
        terminal: {
          status: "cancelled",
          usage: { tokens: 0, turns: 0, elapsedMs: 0 },
          artifactIds: [],
          changedPaths: [],
        },
      } satisfies ChildExecutionResult
      finished.set(key, result)
      return result
    }
    const terminal = yield* input.execution.supervise({
      sessionID: startedChild.sessionId,
      maxTokens: child.maxTokens,
      maxTurns: child.maxTurns,
      timeoutMs: child.timeoutMs,
    })
    const result = cancelled.has(key)
      ? ({ ...startedChild, terminal: { ...terminal, status: "cancelled" } } satisfies ChildExecutionResult)
      : ({ ...startedChild, terminal } satisfies ChildExecutionResult)
    finished.set(key, result)
    return result
  })

  const start = Effect.fn("SchedulerChildSession.start")(function* (child: ChildSessionInput) {
    yield* begin(child)
    return yield* supervise(child)
  })

  const cancel = Effect.fn("SchedulerChildSession.cancel")(function* (
    child: Pick<ChildSessionInput, "rootId" | "taskId">,
  ) {
    const key = leaseKey(child)
    const result = started.get(key)
    if (finished.has(key)) return { observed: false } satisfies ChildCancellation
    if (cancelled.has(key)) return { observed: false } satisfies ChildCancellation
    if (!result) {
      cancelled.add(key)
      return { observed: true } satisfies ChildCancellation
    }
    const outcome = yield* input.execution.interrupt(result?.sessionId ?? childSessionID(child.rootId, child.taskId))
    if (outcome !== undefined && outcome.observed) cancelled.add(key)
    return { observed: outcome !== undefined && outcome.observed } satisfies ChildCancellation
  })

  return { begin, supervise, start, cancel }
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
      terminal?: SessionExecution.TerminalRunResult
    }
  >()
  const finalize = (state: { readonly rootId: string; readonly taskId: string; readonly lease: WorktreeLease }, terminal: SessionExecution.TerminalRunResult) =>
    Effect.gen(function* () {
      const result = terminalResult(terminal)
      const status = result.status
      const evidence = result.evidence
      yield* Effect.promise(() =>
        input.scheduler.useChildBudget({
          key: `task:${state.rootId}:${state.taskId}:budget-used`,
          rootId: state.rootId,
          taskId: state.rootId,
          amount: terminal.usage.tokens,
        }),
      )
      if (status === "cancelled") {
        const task = yield* Effect.promise(() => input.scheduler.getTask(state.rootId, state.taskId))
        if (task.state !== "cancelled") {
          yield* Effect.promise(() =>
            input.scheduler.requestCancellation(
              state.rootId,
              state.taskId,
              "child execution cancelled",
              `task:${state.rootId}:${state.taskId}:cancel`,
            ),
          )
        }
        yield* Effect.promise(() =>
          input.scheduler.acknowledgeCancellation(
            state.rootId,
            state.taskId,
            `task:${state.rootId}:${state.taskId}:cancel-observed`,
          ),
        )
      }
      yield* Effect.promise(() =>
        input.scheduler.commitDeliverable({
          rootId: state.rootId,
          taskId: state.taskId,
          stateKey: `task:${state.rootId}:${state.taskId}:terminal`,
          deliverableKey: `task:${state.rootId}:${state.taskId}:deliverable`,
          status,
          manifest: evidence,
        }),
      )
      yield* Effect.promise(() =>
        input.scheduler.sendMailbox({
          key: `task:${state.rootId}:${state.taskId}:parent-message`,
          rootId: state.rootId,
          messageId: `message_${encodeID(`${state.rootId}\0${state.taskId}`)}`,
          senderTaskId: state.taskId,
          recipientTaskId: state.rootId,
          evidence,
        }),
      )
      yield* input.worktree.release({ rootId: state.rootId, taskId: state.taskId })
      yield* Effect.promise(() =>
        input.scheduler.releaseWorktree(
          state.rootId,
          state.taskId,
          state.lease.location.directory,
          `task:${state.rootId}:${state.taskId}:worktree-released`,
        ),
      )
      const handle = {
        rootId: state.rootId,
        taskId: state.taskId,
        status: status === "completed" ? "completed" : "waiting",
        summary: evidence.summary,
        evidence,
      } satisfies TaskSchedulerAdapter.Handle
      active.set(state.taskId, { ...state, handle })
      return handle
    })
  return {
    schedule: (request) =>
      Effect.gen(function* () {
        const rootId = rootTaskID(request.parent.sessionID, request.parent.messageID)
        const taskId = request.requestedTaskId ?? childTaskID(rootId, request)
        const current = active.get(taskId)
        if (current?.terminal) return yield* finalize({ rootId: current.rootId, taskId, lease: current.lease }, current.terminal)
        if (current) return current.handle
        const maxTokens = request.budget.maxTokens
        const maxTurns = request.budget.maxTurns
        const timeoutMs = request.budget.maxTimeMs
        if (maxTokens === undefined || maxTurns === undefined || timeoutMs === undefined)
          return yield* Effect.fail(new Error("scheduler tasks require maxTokens, maxTurns, and maxTimeMs"))
        if (![maxTokens, maxTurns, timeoutMs].every((value) => Number.isSafeInteger(value) && value > 0))
          return yield* Effect.fail(new Error("scheduler task caps must be positive integers"))
        const budget = maxTokens
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
              requestedMaxTimeMs: timeoutMs,
              forkMode: "none",
              selectedEvidenceArtifactIds: [],
              toolIds: [],
              expectedDeliverable: { name: "task-root", requiredFields: [] },
            },
            budget: { total: rootBudget, fixedCosts: 0 },
          }),
        )
        const root = yield* Effect.promise(() => input.scheduler.getTask(rootId, rootId))
        const childCap = Math.min(maxTokens, root.reserved_child_pool - root.budget_used)
        if (!Number.isSafeInteger(childCap) || childCap <= 0) return yield* Effect.fail(new Error("child budget exhausted"))
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
              requestedMaxTokens: childCap,
              requestedMaxTimeMs: timeoutMs,
              forkMode: request.forkMode,
              selectedEvidenceArtifactIds: [],
              toolIds: request.agent.toolConstraints,
              expectedDeliverable: { name: "task-result", requiredFields: ["summary"] },
            },
            budget: { total: childCap, fixedCosts: 0 },
          }),
        )
        const durable = yield* Effect.promise(() => input.scheduler.getTask(rootId, taskId))
        const executionCap = Math.min(childCap, durable.budget)
        const recovering = durable.state === "running"
        if (!recovering)
          yield* Effect.promise(() => input.scheduler.admit(rootId, taskId, `task:${rootId}:${taskId}:admit`))
        const scope = yield* Scope.make()
        const recovered = yield* (recovering
          ? input.worktree.recover({ rootId, taskId, stateChanging: true })
          : input.worktree.acquire({ rootId, taskId, stateChanging: true }))
          .pipe(Effect.provideService(Scope.Scope, scope), Effect.exit)
        if (Exit.isFailure(recovered)) {
          const failure = Cause.squash(recovered.cause)
          const reason = failure instanceof Error ? failure : new Error(String(failure))
          const worktreeID = durable.worktree_id
          if (!recovering) return yield* Effect.fail(reason)
          const terminal = {
            status: "failed" as const,
            usage: { tokens: 0, turns: 0, elapsedMs: 0 },
            artifactIds: [],
            changedPaths: [],
            blockedReason: boundedReason(reason.message),
          }
          const evidence = terminalResult(terminal).evidence
          yield* Effect.promise(() =>
            input.scheduler.commitDeliverable({
              rootId,
              taskId,
              stateKey: `task:${rootId}:${taskId}:recovery-terminal`,
              deliverableKey: `task:${rootId}:${taskId}:deliverable`,
              status: "failed",
              manifest: evidence,
            }),
          )
          yield* Effect.promise(() =>
            input.scheduler.sendMailbox({
              key: `task:${rootId}:${taskId}:parent-message`,
              rootId,
              messageId: `message_${encodeID(`${rootId}\0${taskId}`)}`,
              senderTaskId: taskId,
              recipientTaskId: rootId,
              evidence,
            }),
          )
          if (worktreeID)
            yield* Effect.promise(() =>
              input.scheduler.releaseWorktree(
                rootId,
                taskId,
                worktreeID,
                `task:${rootId}:${taskId}:worktree-released`,
              ),
            )
          const handle = {
            rootId,
            taskId,
            status: "waiting" as const,
            summary: evidence.summary,
            evidence,
          }
          active.set(taskId, { rootId, lease: undefined as never, handle })
          return handle
        }
        const lease = recovered.value
        if (!recovering)
          yield* Effect.promise(() =>
            input.scheduler.leaseWorktree(
              rootId,
              taskId,
              lease.location.directory,
              `task:${rootId}:${taskId}:worktree-leased`,
            ),
          )
        const childInput = {
          rootId,
          taskId,
          location: lease.location,
          prompt: request.brief,
          agent: request.agent.name,
          model: request.agent.model,
          toolConstraints: request.agent.toolConstraints,
          maxTurns,
          maxTokens: executionCap,
          timeoutMs,
          forkMode: request.forkMode,
          parent: { sessionID: request.parent.sessionID, messageID: request.parent.messageID },
        } satisfies ChildSessionInput
        const running = {
          rootId,
          taskId,
          status: "running",
          summary: "Task scheduled",
          evidence: {
            summary: "Task is running; use the task handle for status.",
            artifactIds: [],
            changedPaths: [],
          },
        } satisfies TaskSchedulerAdapter.Handle
        active.set(taskId, { rootId, lease, handle: running })
        const execute = input.child
          .supervise(childInput)
          .pipe(
            Effect.map((child) => child.terminal),
            Effect.catch((error) =>
              Effect.succeed({
                status: "failed" as const,
                usage: { tokens: 0, turns: 0, elapsedMs: 0 },
                artifactIds: [],
                changedPaths: [],
                blockedReason: error.message,
              }),
            ),
            Effect.andThen((terminal) => {
              active.set(taskId, { rootId, lease, handle: running, terminal })
              return finalize({ rootId, taskId, lease }, terminal)
            }),
          )
        if (request.background) {
          yield* execute.pipe(Effect.onExit((exit) => Scope.close(scope, exit)), Effect.asVoid, Effect.forkIn(scope))
          return running
        }
        return yield* execute.pipe(Effect.onExit((exit) => Scope.close(scope, exit)))
      }),
    cancel: (request) =>
      Effect.gen(function* () {
        const task = yield* Effect.promise(() => input.scheduler.getTask(request.rootId, request.taskId))
        if (["completed", "failed", "cancelled"].includes(task.state)) return { state: "cancelled" } as const
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
        return { state: "cancellation_pending" } as const
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

function terminalTaskState(status: SessionExecution.TerminalRunResult["status"]) {
  if (status === "completed") return "completed" as const
  if (status === "cancelled") return "cancelled" as const
  return "failed" as const
}

function terminalResult(terminal: SessionExecution.TerminalRunResult): {
  readonly status: "completed" | "failed" | "cancelled"
  readonly evidence: TaskSchedulerAdapter.Evidence
} {
  const evidence = {
    summary: terminal.summary ?? terminal.blockedReason ?? terminal.status,
    artifactIds: terminal.artifactIds,
    changedPaths: terminal.changedPaths,
    ...(terminal.testSummary === undefined ? {} : { testSummary: terminal.testSummary }),
    ...(terminal.blockedReason === undefined ? {} : { blockedReason: terminal.blockedReason }),
  }
  if (
    terminal.status === "completed" &&
    terminal.summary === undefined &&
    terminal.artifactIds.length === 0 &&
    terminal.changedPaths.length === 0 &&
    terminal.testSummary === undefined
  ) {
    return {
      status: "failed",
      evidence: {
        ...evidence,
        summary: "Child completed without bounded result evidence",
        blockedReason: "no bounded child result evidence",
      },
    }
  }
  return { status: terminalTaskState(terminal.status), evidence }
}

function encodeID(value: string) {
  return Buffer.from(value).toString("hex")
}

function boundedReason(reason: string) {
  return reason.slice(0, 1_024)
}
