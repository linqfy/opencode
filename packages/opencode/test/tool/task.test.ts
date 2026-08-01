import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { MessageID, type SessionID } from "../../src/session/schema"
import { TaskTool, type TaskSchedulerAdapter } from "../../src/tool/task"
import type { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

afterEach(async () => disposeAllInstances())

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )
const it = testEffect(layer())

const seed = Effect.fn("TaskToolTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Pinned" })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: MessageID.ascending(),
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function adapter(overrides: Partial<TaskSchedulerAdapter.Handle> = {}) {
  const scheduled: TaskSchedulerAdapter.Input[] = []
  const cancelled: { rootId: string; taskId: string; reason: string }[] = []
  const service: TaskSchedulerAdapter = {
    schedule: (input) =>
      Effect.sync(() => {
        scheduled.push(input)
        return {
          taskId: "task_child",
          status: "completed",
          summary: "Cache key inspected",
          evidence: { summary: "Found boundary", artifactIds: ["artifact_cache"], changedPaths: ["src/cache.ts"] },
          ...overrides,
        }
      }),
    cancel: (input) => Effect.sync(() => void cancelled.push(input)),
  }
  return { service, scheduled, cancelled }
}

function context(
  chat: { id: SessionID },
  assistant: { id: MessageID },
  schedulerAdapter: TaskSchedulerAdapter,
  abort = new AbortController(),
): Tool.Context {
  return {
    sessionID: chat.id,
    messageID: assistant.id,
    agent: "build",
    abort: abort.signal,
    extra: { schedulerAdapter, model: ref },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("tool.task", () => {
  it.instance("delegates exactly once with the selected child contract", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const fake = adapter()
      const tool = yield* TaskTool
      const result = yield* (yield* tool.init()).execute(
        {
          description: "inspect cache",
          prompt: "inspect the cache key",
          subagent_type: "general",
          task_id: "task_resume",
        },
        context(chat, assistant, fake.service),
      )

      expect(fake.scheduled).toEqual([
        expect.objectContaining({
          brief: "inspect the cache key",
          description: "inspect cache",
          agent: { name: "general", model: ref, toolConstraints: [] },
          forkMode: "recent",
          budget: { maxTurns: undefined },
          stateChanging: false,
          background: false,
          requestedTaskId: "task_resume",
          parent: expect.objectContaining({
            rootId: chat.id,
            taskId: assistant.id,
            sessionID: chat.id,
            messageID: assistant.id,
          }),
        }),
      ])
      expect(result.metadata.sessionId).toBe("task_child")
    }),
  )

  it.instance("returns structured evidence without a raw child transcript", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const fake = adapter()
      const tool = yield* TaskTool
      const result = yield* (yield* tool.init()).execute(
        { description: "inspect cache", prompt: "inspect", subagent_type: "general" },
        context(chat, assistant, fake.service),
      )

      expect(result.output).toContain("artifact_cache")
      expect(result.output).toContain("Found boundary")
      expect(result.output).not.toContain("raw child transcript")
      expect(result.metadata.artifactIds).toEqual(["artifact_cache"])
    }),
  )

  it.instance("returns a running status handle without claiming completion", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const fake = adapter({ status: "running", summary: "Scheduled" })
      const tool = yield* TaskTool
      const result = yield* (yield* tool.init()).execute(
        { description: "inspect cache", prompt: "inspect", subagent_type: "general" },
        context(chat, assistant, fake.service),
      )

      expect(result.output).toContain('state="running"')
      expect(result.output).not.toContain('state="completed"')
    }),
  )

  it.instance("delegates cancellation once to the scheduler", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const fake = adapter()
      const abort = new AbortController()
      const tool = yield* TaskTool
      yield* (yield* tool.init()).execute(
        { description: "inspect cache", prompt: "inspect", subagent_type: "general" },
        context(chat, assistant, fake.service, abort),
      )
      abort.abort()
      yield* Effect.promise(() => Promise.resolve())

      expect(fake.cancelled).toEqual([{ rootId: chat.id, taskId: "task_child", reason: "parent aborted" }])
    }),
  )

  it.instance("propagates scheduler failures without a synthetic result", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const exit = yield* (yield* tool.init())
        .execute(
          { description: "inspect cache", prompt: "inspect", subagent_type: "general" },
          context(chat, assistant, {
            schedule: () => Effect.die(new Error("scheduler unavailable")),
            cancel: () => Effect.void,
          }),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("scheduler unavailable")
    }),
  )
})
