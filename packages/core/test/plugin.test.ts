import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Fiber } from "effect"
import { define } from "@opencode-ai/plugin/v2/effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { EventV2 } from "@opencode-ai/core/event"
import { Hooks, PluginV2 } from "@opencode-ai/core/plugin"
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
