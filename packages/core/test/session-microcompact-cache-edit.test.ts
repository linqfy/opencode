import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Stream } from "effect"
import type { LLMRequest } from "@opencode-ai/llm"
import { LLM, LLMEvent, Message, Model } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const created = DateTime.makeUnsafe(0)
const messageID = (value: string) => SessionMessage.ID.make(`msg_${value}`)
const modelRef = { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("openai") }
const assistantTime = { created, completed: created }

const user = (n: string, text: string) => SessionMessage.User.make({ id: messageID(n), type: "user", text, time: { created } })
const textPart = (n: string, t: string) => SessionMessage.AssistantText.make({ type: "text", id: `p_${n}`, text: t })
const assistant = (n: string, content: SessionMessage.AssistantContent[]) =>
  SessionMessage.Assistant.make({ id: messageID(n), type: "assistant", agent: "build", model: modelRef, content, time: assistantTime })
const completed = (output: string) =>
  SessionMessage.ToolStateCompleted.make({
    status: "completed",
    input: {},
    content: [{ type: "text", text: output }],
    structured: {},
  })
const tool = (n: string, name: string, state: SessionMessage.ToolState) =>
  SessionMessage.AssistantTool.make({ type: "tool", id: `p_${n}`, name, state, time: assistantTime })
const entry = (seq: number, message: SessionMessage.Message) => ({ seq, message })

// A history of compactable tool results beyond the microcompact keep window
// (five results / two turns), so the staged pipeline clears a known set of
// tool-result parts. A previous compaction anchors the summarization stage.
const fixture = [
  entry(1, SessionMessage.Compaction.make({ id: messageID("prev"), type: "compaction", reason: "auto", summary: "Old summary", recent: "Old recent", time: { created } })),
  entry(2, user("u1", "Explore the workspace")),
  entry(3, assistant("a1", [tool("r1", "bash", completed("listing"))])),
  entry(4, user("u2", "Read the README")),
  entry(5, assistant("a2", [tool("r2", "read", completed("readme"))])),
  entry(6, user("u3", "Grep for the entrypoint")),
  entry(7, assistant("a3", [tool("r3", "grep", completed("entrypoint found"))])),
  entry(8, user("u4", "Run the build")),
  entry(9, assistant("a4", [tool("r4", "bash", completed("build ok"))])),
  entry(10, user("u5", "Run the tests")),
  entry(11, assistant("a5", [tool("r5", "read", completed("tests green"))])),
  entry(12, user("u6", "Stage the changes")),
  entry(13, assistant("a6", [tool("r6", "bash", completed("staged"))])),
  entry(14, user("u7", "Commit")),
  entry(15, assistant("a7", [tool("r7", "bash", completed("committed"))])),
  entry(16, user("u8", "Push to origin")),
  entry(17, assistant("a8", [tool("r8", "bash", completed("pushed"))])),
  entry(18, user("u9", "Wrap up")),
  entry(19, assistant("a9", [textPart("t1", "All done")])),
]

const SUMMARY = "## Objective\nVerified the pipeline works end to end."

const pipelineInput = {
  sessionID: SessionSchema.ID.make("ses_cache_edit_test"),
  entries: fixture,
  contextEpoch: 0,
}

const configDocument = () =>
  new Config.Document({
    type: "document",
    info: new Config.Info({
      compaction: new ConfigCompaction.Info({ keep: new ConfigCompaction.Keep({ tokens: 20_000 }) }),
    }),
  })

const scriptedStream = (request: LLMRequest) => Stream.succeed(LLMEvent.textDelta({ id: "c1", text: SUMMARY }))

const live = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])),
)

const runPipeline = (cacheEdit: boolean) => {
  const model = Model.make({
    id: "test-model",
    provider: "openai",
    route: OpenAIChat.route.with({ limits: { context: 200_000, output: 4_096 } }),
    compatibility: cacheEdit ? { cacheEdit: true } : undefined,
  })
  return Effect.runPromise(
    SessionCompaction.CompactionPipeline.run(
      { llm: { stream: scriptedStream }, config: [configDocument()] },
      {
        ...pipelineInput,
        model,
        request: LLM.request({ model, messages: [Message.user("continue")], tools: [] }),
      },
    ),
  )
}

describe("cache-edit-aware microcompaction", () => {
  test("emits { kind: 'cache-edit', partIds } with the cleared tool-result part ids when the model advertises cacheEdit", async () => {
    const result = await runPipeline(true)

    expect(result).toBeDefined()
    if (result === undefined) return

    expect(result.cacheEdit).toEqual({ kind: "cache-edit", partIds: ["p_r1", "p_r2", "p_r3"] })
    expect(result.cacheEdit?.partIds).toEqual(result.clearedPartIds)
  })

  test("emits no cache-edit ops when the model does not advertise cacheEdit", async () => {
    const result = await runPipeline(false)

    expect(result).toBeDefined()
    if (result === undefined) return

    expect(result.cacheEdit).toBeUndefined()
  })

  test("the durable cleared state is identical in both modes", async () => {
    const on = await runPipeline(true)
    const off = await runPipeline(false)

    expect(on?.clearedPartIds).toEqual(off?.clearedPartIds)
    expect(on?.summaryMessage.reason).toEqual(off?.summaryMessage.reason)
    expect(on?.summaryMessage.summary).toEqual(off?.summaryMessage.summary)
    expect(on?.summaryMessage.recent).toEqual(off?.summaryMessage.recent)
    expect(on?.checkpoint).toEqual(off?.checkpoint)
  })
})

describe("cache-edit ops reach the runner", () => {
  live.effect("threads { kind: 'cache-edit', partIds } on the overflow return for a cacheEdit model", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const compaction = SessionCompaction.make({
        events,
        llm: { stream: scriptedStream },
        config: [configDocument()],
      })
      const model = Model.make({
        id: "test-model",
        provider: "openai",
        route: OpenAIChat.route.with({ limits: { context: 200_000, output: 4_096 } }),
        compatibility: { cacheEdit: true },
      })
      const compacted = yield* compaction.compactAfterOverflow({
        ...pipelineInput,
        model,
        request: LLM.request({ model, messages: [Message.user("continue")], tools: [] }),
      })
      expect(compacted).toEqual({ cacheEdit: { kind: "cache-edit", partIds: ["p_r1", "p_r2", "p_r3"] } })
    }),
  )

  live.effect("still returns true on the overflow return when the model does not advertise cacheEdit", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const compaction = SessionCompaction.make({
        events,
        llm: { stream: scriptedStream },
        config: [configDocument()],
      })
      const model = Model.make({
        id: "test-model",
        provider: "openai",
        route: OpenAIChat.route.with({ limits: { context: 200_000, output: 4_096 } }),
      })
      const compacted = yield* compaction.compactAfterOverflow({
        ...pipelineInput,
        model,
        request: LLM.request({ model, messages: [Message.user("continue")], tools: [] }),
      })
      expect(compacted).toBe(true)
    }),
  )
})
