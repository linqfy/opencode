import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Exit, Fiber } from "effect"
import { define, type PluginBundleManifest } from "@opencode-ai/plugin/v2/effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { EventV2 } from "@opencode-ai/core/event"
import { Bundle, Hooks, PluginV2 } from "@opencode-ai/core/plugin"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

describe("PluginV2", () => {
  it.effect("dispatches lifecycle hooks in registration order", () =>
    Effect.gen(function* () {
      const hooks = yield* Hooks.Service
      const received: string[] = []
      yield* hooks.onSessionStarted(() => Effect.sync(() => received.push("first")))
      yield* hooks.onSessionStarted(() => Effect.sync(() => received.push("second")))

      yield* hooks.emitSessionStarted({ sessionID: "ses_order", directory: "/workspace", timestamp: 1 })

      expect(received).toEqual(["first", "second"])
    }),
  )

  it.effect("does not invoke a disposed lifecycle hook", () =>
    Effect.gen(function* () {
      const hooks = yield* Hooks.Service
      let calls = 0
      const registration = yield* hooks.onSessionStarted(() => Effect.sync(() => calls++))

      yield* registration.dispose
      yield* hooks.emitSessionStarted({ sessionID: "ses_disposed", directory: "/workspace", timestamp: 1 })

      expect(calls).toBe(0)
    }),
  )

  it.effect("isolates failing lifecycle hooks", () =>
    Effect.gen(function* () {
      const hooks = yield* Hooks.Service
      let received = false
      yield* hooks.onToolProposed(() => Effect.die("boom"))
      yield* hooks.onToolProposed(() => Effect.sync(() => (received = true)))

      yield* hooks.emitToolProposed({
        sessionID: "ses_isolated",
        assistantMessageID: "msg_assistant",
        callID: "call_isolated",
        tool: "bash",
        providerExecuted: false,
      })

      expect(received).toBe(true)
    }),
  )

  it.effect("isolates interrupted lifecycle hooks", () =>
    Effect.gen(function* () {
      const hooks = yield* Hooks.Service
      let received = false
      yield* hooks.onToolProposed(() => Effect.interrupt)
      yield* hooks.onToolProposed(() => Effect.sync(() => (received = true)))

      yield* hooks.emitToolProposed({
        sessionID: "ses_interrupted",
        assistantMessageID: "msg_assistant",
        callID: "call_interrupted",
        tool: "bash",
        providerExecuted: false,
      })

      expect(received).toBe(true)
    }),
  )

  it.effect("maps live V2 session events to lifecycle hooks", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const hooks = yield* Hooks.Service
      const sessionID = SessionV2.ID.make("ses_lifecycle")
      const assistantMessageID = SessionMessage.ID.make("msg_assistant")
      const started: unknown[] = []
      const proposed: unknown[] = []
      const completed: unknown[] = []
      yield* hooks.onSessionStarted((event) => Effect.sync(() => started.push(event)))
      yield* hooks.onToolProposed((event) => Effect.sync(() => proposed.push(event)))
      yield* hooks.onTurnCompleted((event) => Effect.sync(() => completed.push(event)))

      yield* events.publish(SessionV1.Event.Created, {
        sessionID,
        info: SessionV1.SessionInfo.make({
          id: sessionID,
          slug: "lifecycle",
          version: "test",
          projectID: Project.ID.global,
          directory: AbsolutePath.make("/workspace"),
          title: "lifecycle",
          time: { created: 12, updated: 12 },
        }),
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: DateTime.makeUnsafe(13),
        assistantMessageID,
        callID: "call_lifecycle",
        tool: "bash",
        input: {},
        provider: { executed: true },
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(14),
        assistantMessageID,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      expect(started).toEqual([{ sessionID, directory: "/workspace", timestamp: 12 }])
      expect(proposed).toEqual([
        { sessionID, assistantMessageID, callID: "call_lifecycle", tool: "bash", providerExecuted: true },
      ])
      expect(completed).toHaveLength(1)
      expect(completed[0]).toMatchObject({ sessionID, assistantMessageID, finish: "stop" })
      expect((completed[0] as { timestamp: number }).timestamp).toEqual(expect.any(Number))
    }),
  )

  it.effect("delivers explicitly emitted artifact hooks", () =>
    Effect.gen(function* () {
      const hooks = yield* Hooks.Service
      const received: unknown[] = []
      yield* hooks.onArtifactStored((event) => Effect.sync(() => received.push(event)))

      yield* hooks.emitArtifactStored({ artifactID: "art_1", mime: "text/plain", byteLength: 4, hash: "hash" })

      expect(received).toEqual([{ artifactID: "art_1", mime: "text/plain", byteLength: 4, hash: "hash" }])
    }),
  )

  it.effect("does not replay lifecycle events registered after publication", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const hooks = yield* Hooks.Service
      const sessionID = SessionV2.ID.make("ses_no_replay")
      let calls = 0
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_no_replay"),
        callID: "call_no_replay",
        tool: "bash",
        input: {},
        provider: { executed: false },
      })

      yield* hooks.onToolProposed(() => Effect.sync(() => calls++))

      expect(calls).toBe(0)
    }),
  )

  it.effect("waits for a plugin and returns immediately once active", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const id = PluginV2.ID.make("waited")
      const waiting = yield* plugins.wait(id).pipe(Effect.forkChild)

      yield* plugins.add(id, () => Effect.void)
      yield* Fiber.join(waiting)
      yield* plugins.wait(id)
    }),
  )

  it.effect("propagates plugin activation defects to waiters", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const id = PluginV2.ID.make("failed")
      const waiting = yield* plugins.wait(id).pipe(Effect.exit, Effect.forkChild)

      const added = yield* plugins.add(id, () => Effect.die("boom")).pipe(Effect.exit)
      const pending = yield* Fiber.join(waiting)
      const later = yield* plugins.wait(id).pipe(Effect.exit)

      expect(Exit.isFailure(added)).toBe(true)
      expect(Exit.isFailure(pending)).toBe(true)
      expect(Exit.isFailure(later)).toBe(true)
    }),
  )

  it.effect("adds, replaces, and removes plugins", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      let description = "first"

      const managed = () =>
        define({
          id: "managed",
          effect: (ctx) =>
            ctx.agent
              .transform((agents) =>
                agents.update("configured", (agent) => {
                  agent.description = description
                }),
              )
              .pipe(Effect.asVoid),
        })

      yield* plugins.add(PluginV2.ID.make("managed"), managed().effect)

      expect((yield* agents.get(AgentV2.ID.make("configured")))?.description).toBe("first")

      description = "second"
      yield* plugins.add(PluginV2.ID.make("managed"), managed().effect)
      expect((yield* agents.get(AgentV2.ID.make("configured")))?.description).toBe("second")

      yield* plugins.remove(PluginV2.ID.make("managed"))
      expect(yield* agents.get(AgentV2.ID.make("configured"))).toBeUndefined()
    }),
  )
})

describe("PluginBundle", () => {
  const manifest = (id = "bundle"): PluginBundleManifest => ({
    id,
    version: "1.0.0",
    provenance: { source: "test", location: "/bundle.json" },
    permissions: [],
    startup: "lazy",
    contributions: {},
  })

  it.effect("does not call a loader during discovery", () =>
    Effect.gen(function* () {
      const bundles = yield* Bundle.Service
      let calls = 0

      yield* bundles.discover(manifest(), () =>
        Effect.sync(() => {
          calls++
          return define({ id: "bundle", effect: () => Effect.void })
        }),
      )

      expect(calls).toBe(0)
      expect((yield* bundles.list())[0]?.status).toBe("discovered")
    }),
  )

  it.effect("activates discovered bundles only when requested", () =>
    Effect.gen(function* () {
      const bundles = yield* Bundle.Service
      const plugins = yield* PluginV2.Service
      let calls = 0
      yield* bundles.discover(manifest(), () =>
        Effect.sync(() => {
          calls++
          return define({ id: "bundle", effect: () => Effect.void })
        }),
      )

      yield* bundles.activate("bundle")

      expect(calls).toBe(1)
      expect((yield* bundles.list())[0]?.status).toBe("active")
      yield* plugins.wait(PluginV2.ID.make("bundle"))
    }),
  )

  it.effect("unloads active bundle effects and is idempotent", () =>
    Effect.gen(function* () {
      const bundles = yield* Bundle.Service
      const agents = yield* AgentV2.Service
      yield* bundles.discover(manifest(), () =>
        Effect.succeed(
          define({
            id: "bundle",
            effect: (ctx) =>
              ctx.agent.transform((agents) =>
                agents.update("bundled", (agent) => {
                  agent.description = "registered by bundle"
                  agent.mode = "subagent"
                }),
              ),
          }),
        ),
      )

      yield* bundles.activate("bundle")
      expect(yield* agents.get(AgentV2.ID.make("bundled"))).toBeDefined()
      yield* bundles.unload("bundle")
      yield* bundles.unload("bundle")

      expect(yield* agents.get(AgentV2.ID.make("bundled"))).toBeUndefined()
      expect((yield* bundles.list())[0]?.status).toBe("unloaded")
      yield* bundles.activate("bundle")
      expect(yield* agents.get(AgentV2.ID.make("bundled"))).toBeDefined()
    }),
  )

  it.effect("retries failed activation and records a safe health message", () =>
    Effect.gen(function* () {
      const bundles = yield* Bundle.Service
      let attempts = 0
      yield* bundles.discover(manifest(), () =>
        Effect.sync(() => {
          attempts++
          if (attempts === 1) throw new Error("secret stack detail")
          return define({ id: "bundle", effect: () => Effect.void })
        }),
      )

      const failed = yield* bundles.activate("bundle").pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      expect((yield* bundles.list())[0]).toMatchObject({ status: "failed", health: { message: "Bundle activation failed" } })

      yield* bundles.activate("bundle")
      expect(attempts).toBe(2)
      expect((yield* bundles.list())[0]?.status).toBe("active")
    }),
  )

  it.effect("waits for a loading bundle activation to complete", () =>
    Effect.gen(function* () {
      const bundles = yield* Bundle.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const secondCompleted = yield* Deferred.make<void>()
      yield* bundles.discover(manifest(), () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(define({ id: "bundle", effect: () => Effect.void })),
        ),
      )

      const first = yield* bundles.activate("bundle").pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const second = yield* bundles
        .activate("bundle")
        .pipe(Effect.andThen(Deferred.succeed(secondCompleted, undefined)), Effect.forkChild)
      yield* Effect.yieldNow

      expect(yield* Deferred.isDone(secondCompleted)).toBe(false)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect((yield* bundles.list())[0]?.status).toBe("active")
    }),
  )

  it.effect("shares a loading bundle activation failure with concurrent callers", () =>
    Effect.gen(function* () {
      const bundles = yield* Bundle.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* bundles.discover(manifest(), () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.fail(new Error("loader failure"))),
        ),
      )

      const first = yield* bundles.activate("bundle").pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(started)
      const second = yield* bundles.activate("bundle").pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.succeed(release, undefined)

      const firstExit = yield* Fiber.join(first)
      const secondExit = yield* Fiber.join(second)
      expect(Exit.isFailure(firstExit)).toBe(true)
      expect(secondExit).toEqual(firstExit)
    }),
  )

  it.effect("rejects unloading a bundle while activation is loading", () =>
    Effect.gen(function* () {
      const bundles = yield* Bundle.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* bundles.discover(manifest(), () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(define({ id: "bundle", effect: () => Effect.void })),
        ),
      )

      const activation = yield* bundles.activate("bundle").pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const unload = yield* bundles.unload("bundle").pipe(Effect.exit)

      expect(Exit.isFailure(unload)).toBe(true)
      if (Exit.isFailure(unload)) expect(String(unload.cause)).toContain("Cannot unload plugin bundle while activation is loading: bundle")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(activation)
    }),
  )

  it.effect("rejects conflicting manifests and makes active activation a no-op", () =>
    Effect.gen(function* () {
      const bundles = yield* Bundle.Service
      let calls = 0
      const load = () =>
        Effect.sync(() => {
          calls++
          return define({ id: "bundle", effect: () => Effect.void })
        })
      yield* bundles.discover(manifest(), load)
      yield* bundles.discover(manifest(), load)
      const conflict = yield* bundles.discover({ ...manifest(), version: "2.0.0" }, load).pipe(Effect.exit)
      yield* bundles.activate("bundle")
      yield* bundles.activate("bundle")

      expect(Exit.isFailure(conflict)).toBe(true)
      expect(calls).toBe(1)
    }),
  )

  it.effect("fails missing bundle operations with stable errors", () =>
    Effect.gen(function* () {
      const bundles = yield* Bundle.Service
      const activation = yield* bundles.activate("missing").pipe(Effect.exit)
      const unload = yield* bundles.unload("missing").pipe(Effect.exit)

      expect(Exit.isFailure(activation)).toBe(true)
      expect(Exit.isFailure(unload)).toBe(true)
      if (Exit.isFailure(activation)) expect(String(activation.cause)).toContain("Unknown plugin bundle: missing")
      if (Exit.isFailure(unload)) expect(String(unload.cause)).toContain("Unknown plugin bundle: missing")
    }),
  )

  it.effect("rejects malformed manifests", () =>
    Effect.sync(() => {
      const valid = manifest()
      expect(() => Bundle.decodeManifest({ ...valid, permissions: [1] })).toThrow()
      expect(() => Bundle.decodeManifest({ ...valid, startup: "later" })).toThrow()
      expect(() => Bundle.decodeManifest({ ...valid, contributions: { tools: "yes" } })).toThrow()
      expect(() => Bundle.decodeManifest({ ...valid, contributions: { permissionDefaults: true } })).toThrow(
        "Plugin bundle permission defaults are not supported",
      )
      expect(() => Bundle.decodeManifest({ ...valid, id: undefined })).toThrow()
      expect(Bundle.decodeManifest({ ...valid, futureField: "accepted" })).toEqual(valid)
    }),
  )
})
