import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { MessageID, type SessionID } from "../../src/session/schema"
import { Parameters, TaskTool, type TaskSchedulerAdapter } from "../../src/tool/task"
import type { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { WaitTimeoutError } from "@ultracode/agents"

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

const seed = Effect.fn("TaskWaitTest.seed")(function* () {
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

function adapter(
  overrides: Partial<TaskSchedulerAdapter.Handle> = {},
  wait: TaskSchedulerAdapter["wait"] = () => Effect.succeed({ taskId: "task_child", state: "completed" as const }),
) {
  const scheduled: TaskSchedulerAdapter.Input[] = []
  const cancelled: { rootId: string; taskId: string; reason: string }[] = []
  const waited: { rootId: string; taskId: string; timeoutMs: number }[] = []
  const service: TaskSchedulerAdapter = {
    schedule: (input) =>
      Effect.sync(() => {
        scheduled.push(input)
        return {
          rootId: "root_parent",
          taskId: "task_child",
          status: "completed",
          summary: "Cache key inspected",
          evidence: { summary: "Found boundary", artifactIds: ["artifact_cache"], changedPaths: ["src/cache.ts"] },
          ...overrides,
        }
      }),
    cancel: (input) => Effect.sync(() => (cancelled.push(input), { state: "cancellation_pending" as const })),
    wait: (input) => {
      waited.push(input)
      return wait(input)
    },
  }
  return { service, scheduled, cancelled, waited }
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

describe("tool.task wait", () => {
  test("decodes waitMs within the bound", () => {
    const params = Schema.decodeUnknownSync(Parameters)({
      description: "inspect cache",
      prompt: "inspect",
      subagent_type: "general",
      maxTurns: 4,
      maxTokens: 1_200,
      timeoutMs: 30_000,
      waitMs: 500,
    })

    expect(params.waitMs).toBe(500)
  })

  test("rejects waitMs beyond the 600s cap", () => {
    expect(() =>
      Schema.decodeUnknownSync(Parameters)({
        description: "inspect cache",
        prompt: "inspect",
        subagent_type: "general",
        maxTurns: 4,
        maxTokens: 1_200,
        timeoutMs: 30_000,
        waitMs: 999_999_999,
      }),
    ).toThrow()
  })

  it.instance("waits for a terminal outcome and renders the deliverable summary", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const fake = adapter({}, () =>
        Effect.succeed({
          taskId: "task_child",
          state: "completed",
          deliverable: {
            root_id: "root_parent",
            task_id: "task_child",
            status: "completed",
            summary: "Fixed the cache boundary",
            artifact_ids: ["artifact_cache"],
            changed_paths: ["src/cache.ts", "src/cache.test.ts"],
            test_summary: "12 passing",
          },
        } as const),
      )
      const tool = yield* TaskTool
      const result = yield* (yield* tool.init()).execute(
        {
          description: "inspect cache",
          prompt: "inspect",
          subagent_type: "general",
          maxTurns: 4,
          maxTokens: 1_200,
          timeoutMs: 30_000,
          waitMs: 500,
        },
        context(chat, assistant, fake.service),
      )

      expect(fake.waited).toEqual([{ rootId: "root_parent", taskId: "task_child", timeoutMs: 500 }])
      expect(result.output).toContain("Fixed the cache boundary")
      expect(result.output).toContain("src/cache.test.ts")
      expect(result.output).toContain('state="completed"')
    }),
  )

  it.instance("reports a still-running task without failing when the wait times out", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const fake = adapter({}, () => Effect.fail(new WaitTimeoutError(["task_child"])))
      const tool = yield* TaskTool
      const result = yield* (yield* tool.init()).execute(
        {
          description: "inspect cache",
          prompt: "inspect",
          subagent_type: "general",
          maxTurns: 4,
          maxTokens: 1_200,
          timeoutMs: 30_000,
          waitMs: 500,
        },
        context(chat, assistant, fake.service),
      )

      expect(result.output).toContain("still running")
      expect(result.output).toContain("task_child")
    }),
  )

  it.instance("renders a cancelled outcome with the task id", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const fake = adapter({}, () => Effect.succeed({ taskId: "task_child", state: "cancelled" } as const))
      const tool = yield* TaskTool
      const result = yield* (yield* tool.init()).execute(
        {
          description: "inspect cache",
          prompt: "inspect",
          subagent_type: "general",
          maxTurns: 4,
          maxTokens: 1_200,
          timeoutMs: 30_000,
          waitMs: 500,
        },
        context(chat, assistant, fake.service),
      )

      expect(result.output).toContain("task_child")
      expect(result.output).toContain('state="cancelled"')
    }),
  )
})
