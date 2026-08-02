export * as SessionRunCoordinator from "./run-coordinator"

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E, A = void, Input = void> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key, input?: Input) => Effect.Effect<A, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
}

type Entry<A, E> = {
  readonly done: Deferred.Deferred<A, E>
  owner?: Fiber.Fiber<void, never>
  pendingWake: boolean
  stopping: boolean
}

export const make = <Key, E, A = void, Input = void>(options: {
  readonly drain: (key: Key, force: boolean, input?: Input) => Effect.Effect<A, E>
}): Effect.Effect<Coordinator<Key, E, A, Input>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<A, E>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const makeEntry = (): Entry<A, E> => ({
      done: Deferred.makeUnsafe<A, E>(),
      pendingWake: false,
      stopping: false,
    })

    const start = (key: Key, entry: Entry<A, E>, force: boolean, input?: Input, successor = false) => {
      const ready = Deferred.makeUnsafe<void>()
      const drain = Effect.suspend(() => options.drain(key, force, input))
      const owner = fork(
        Effect.suspend(() =>
          successor ? Effect.yieldNow.pipe(Effect.andThen(drain)) : Deferred.await(ready).pipe(Effect.andThen(drain)),
        ).pipe(
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<A, E>, exit: Exit.Exit<A, E>) => {
      if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
        entry.pendingWake = false
        start(key, entry, false, undefined, true)
        return
      }

      const successor = entry.pendingWake ? makeEntry() : undefined
      if (successor === undefined) active.delete(key)
      else {
        active.set(key, successor)
        start(key, successor, false, undefined, true)
      }
      Deferred.doneUnsafe(entry.done, exit)
    }

    const run = (key: Key, input?: Input): Effect.Effect<A, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          return restore(Deferred.await(entry.done))
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, true, input)
        return restore(Deferred.await(next.done))
      })

    const wake = (key: Key) =>
      Effect.sync(() => {
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.pendingWake = true
          return
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, false)
      })

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined) return Effect.void
        entry.stopping = true
        entry.pendingWake = false
        return Fiber.interrupt(entry.owner)
      })

    return { active: Effect.sync(() => new Set(active.keys())), run, wake, interrupt }
  })
