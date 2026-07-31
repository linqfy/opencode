export * as Hooks from "./hooks"

import type {
  ArtifactStored,
  Hooks as PublicHooks,
  Registration,
  SessionStarted,
  ToolProposed,
  TurnCompleted,
} from "@opencode-ai/plugin/v2/effect"
import { Context, Effect, Layer, Scope } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionEvent } from "../session/event"
import { SessionV1 } from "../v1/session"

type Callback<Event> = (event: Event) => Effect.Effect<void> | void
type Entry<Event> = { readonly callback: Callback<Event> }

export interface Interface extends PublicHooks {
  readonly emitSessionStarted: (event: SessionStarted) => Effect.Effect<void>
  readonly emitToolProposed: (event: ToolProposed) => Effect.Effect<void>
  readonly emitTurnCompleted: (event: TurnCompleted) => Effect.Effect<void>
  readonly emitArtifactStored: (event: ArtifactStored) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/PluginHooks") {}

const register = <Event>(entries: Entry<Event>[], callback: Callback<Event>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const entry = { callback }
    let active = true
    const dispose = Effect.sync(() => {
      if (!active) return
      active = false
      const index = entries.indexOf(entry)
      if (index >= 0) entries.splice(index, 1)
    })
    entries.push(entry)
    yield* Scope.addFinalizer(scope, dispose)
    return { dispose } satisfies Registration
  })

const dispatch = <Event>(entries: Entry<Event>[], event: Event) =>
  Effect.forEach(
    entries,
    (entry) =>
      Effect.suspend(() => {
        const result = entry.callback(event)
        return Effect.isEffect(result) ? Effect.asVoid(result) : Effect.void
      }).pipe(Effect.catchCause(() => Effect.void)),
    { discard: true },
  )

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const sessionStarted: Entry<SessionStarted>[] = []
    const toolProposed: Entry<ToolProposed>[] = []
    const turnCompleted: Entry<TurnCompleted>[] = []
    const artifactStored: Entry<ArtifactStored>[] = []
    const emitSessionStarted = (event: SessionStarted) => dispatch(sessionStarted, event)
    const emitToolProposed = (event: ToolProposed) => dispatch(toolProposed, event)
    const emitTurnCompleted = (event: TurnCompleted) => dispatch(turnCompleted, event)
    const emitArtifactStored = (event: ArtifactStored) => dispatch(artifactStored, event)
    const unsubscribe = yield* events.listen((event) => {
      if (event.type === SessionV1.Event.Created.type) {
        const data = event.data as typeof SessionV1.Event.Created.data.Type
        return emitSessionStarted({
          sessionID: data.sessionID,
          directory: data.info.directory,
          timestamp: data.info.time.created,
        })
      }
      if (event.type === SessionEvent.Tool.Called.type) {
        const data = event.data as typeof SessionEvent.Tool.Called.data.Type
        return emitToolProposed({
          sessionID: data.sessionID,
          assistantMessageID: data.assistantMessageID,
          callID: data.callID,
          tool: data.tool,
          providerExecuted: data.provider.executed,
        })
      }
      if (event.type === SessionEvent.Step.Ended.type) {
        const data = event.data as typeof SessionEvent.Step.Ended.data.Type
        return emitTurnCompleted({
          sessionID: data.sessionID,
          assistantMessageID: data.assistantMessageID,
          finish: data.finish,
          timestamp: Date.now(),
        })
      }
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    return Service.of({
      onSessionStarted: (callback) => register(sessionStarted, callback),
      onToolProposed: (callback) => register(toolProposed, callback),
      onTurnCompleted: (callback) => register(turnCompleted, callback),
      onArtifactStored: (callback) => register(artifactStored, callback),
      emitSessionStarted,
      emitToolProposed,
      emitTurnCompleted,
      emitArtifactStored,
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node] })
