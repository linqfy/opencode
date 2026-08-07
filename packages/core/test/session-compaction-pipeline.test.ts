import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Stream } from "effect"
import type { LLMRequest } from "@opencode-ai/llm"
import { InvalidRequestReason, LLM, LLMError, LLMEvent, Message, Model } from "@opencode-ai/llm"
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
const assistant = (n: string, content: SessionMessage.AssistantContent[]) =>
  SessionMessage.Assistant.make({ id: messageID(n), type: "assistant", agent: "build", model: modelRef, content, time: assistantTime })
const textPart = (n: string, t: string) => SessionMessage.AssistantText.make({ type: "text", id: `p_${n}`, text: t })
const completed = (output: string, outputPaths?: string[]) =>
  SessionMessage.ToolStateCompleted.make({
    status: "completed",
    input: {},
    content: [{ type: "text", text: output }],
    structured: {},
    ...(outputPaths === undefined ? {} : { outputPaths }),
  })
const failed = (message: string) =>
  SessionMessage.ToolStateError.make({
    status: "error",
    input: {},
    content: [],
    structured: {},
    error: { type: "unknown", message },
  })
const tool = (n: string, name: string, state: SessionMessage.ToolState) =>
  SessionMessage.AssistantTool.make({ type: "tool", id: `p_${n}`, name, state, time: assistantTime })
const entry = (seq: number, message: SessionMessage.Message) => ({ seq, message })

const DUP_TEXT = "identical-scan-result-fragment-xyz"
const BIG_PREFIX = "big-line\n"
const BIG_SUFFIX = "\nEND-OF-BUILD-LOG"
const BIG_OUTPUT = `${BIG_PREFIX}${"a".repeat(60_000)}${BIG_SUFFIX}`
const MANAGED_PATH = "/managed/build-output.log"
const TAGGED_ERROR = "Permission denied: src/index.ts"

// 30-message history: two identical text outputs (dedupe), a ~60KB tool output
// (artifact-preview), a stale errored tool result (protection tag), and a
// trailing two-turn tail for recentTailStart. A previous compaction message
// anchors the summarization stage.
const fixture = [
  entry(1, SessionMessage.Compaction.make({ id: messageID("prev"), type: "compaction", reason: "auto", summary: "Old summary", recent: "Old recent", time: { created } })),
  entry(2, user("u1", "Explore the workspace")),
  entry(3, assistant("a1", [textPart("t1", "Listing the project root")])),
  entry(4, assistant("a2", [tool("r1", "bash", completed("package.json\nsrc\ntest"))])),
  entry(5, user("u2", "Read the README")),
  entry(6, assistant("a3", [tool("r2", "read", completed("Welcome to the project"))])),
  entry(7, assistant("a4", [textPart("t2", DUP_TEXT), textPart("t3", DUP_TEXT)])),
  entry(8, user("u3", "Run the build")),
  entry(9, assistant("a5", [tool("r3", "bash", completed(BIG_OUTPUT, [MANAGED_PATH]))])),
  entry(10, assistant("a6", [textPart("t4", "Build output is large")])),
  entry(11, user("u4", "What changed in src?")),
  entry(12, assistant("a7", [tool("r4", "grep", completed("function compile"))])),
  entry(13, assistant("a8", [tool("r5", "read", failed(TAGGED_ERROR))])),
  entry(14, user("u5", "Check the tests")),
  entry(15, assistant("a9", [tool("r6", "bash", completed("1 pass, 0 fail"))])),
  entry(16, assistant("a10", [textPart("t5", "All tests pass")])),
  entry(17, user("u6", "Stage the changes")),
  entry(18, assistant("a11", [tool("r7", "bash", completed("staged 3 files"))])),
  entry(19, user("u7", "Commit")),
  entry(20, assistant("a12", [tool("r8", "bash", completed("committed"))])),
  entry(21, user("u8", "Push to origin")),
  entry(22, assistant("a13", [tool("r9", "bash", completed("pushed"))])),
  entry(23, assistant("a14", [textPart("t6", "Pushed successfully")])),
  entry(24, user("u9", "Show the diff")),
  entry(25, assistant("a15", [tool("r10", "bash", completed("diff --stat"))])),
  entry(26, user("u10", "Summarize the work")),
  entry(27, assistant("a16", [textPart("t7", "Summary follows")])),
  entry(28, user("u11", "Anything else?")),
  entry(29, assistant("a17", [tool("r11", "read", completed("clean tree"))])),
  entry(30, user("u12", "Great, wrap up")),
  entry(31, assistant("a18", [textPart("t8", "Wrapping up")])),
]

const SUMMARY = "## Objective\nVerified the build pipeline works end to end."

const model = Model.make({
  id: "test-model",
  provider: "openai",
  route: OpenAIChat.route.with({ limits: { context: 200_000, output: 4_096 } }),
})

const pipelineInput = {
  sessionID: SessionSchema.ID.make("ses_pipeline_test"),
  entries: fixture,
  model,
  request: LLM.request({ model, messages: [Message.user("continue")], tools: [] }),
  contextEpoch: 0,
}

const configDocument = (buffer?: number, tokens?: number) =>
  new Config.Document({
    type: "document",
    info: new Config.Info({
      compaction: new ConfigCompaction.Info({
        ...(buffer === undefined ? {} : { buffer }),
        ...(tokens === undefined ? {} : { keep: new ConfigCompaction.Keep({ tokens }) }),
      }),
    }),
  })

const scriptedStream = (summary: string) => (request: LLMRequest) =>
  Stream.succeed(LLMEvent.textDelta({ id: "c1", text: summary }))

describe("CompactionPipeline", () => {
  test("staged pipeline dedupes, previews oversized output, protects tagged parts, and emits a checkpoint", async () => {
    const result = await Effect.runPromise(
      SessionCompaction.CompactionPipeline.run(
        { llm: { stream: scriptedStream(SUMMARY) }, config: [configDocument(undefined, 20_000)] },
        pipelineInput,
      ),
    )

    expect(result).toBeDefined()
    if (result === undefined) return

    expect(result.summaryMessage.type).toBe("compaction")
    expect(result.summaryMessage.reason).toBe("auto")
    expect(result.summaryMessage.summary).toBe(SUMMARY)
    expect(result.summaryMessage.recent).toContain(DUP_TEXT)

    // Dedupe: the two identical text blocks collapse to one in the post-stage conversation.
    expect(result.summaryMessage.recent.split(DUP_TEXT).length - 1).toBe(1)

    // Artifact preview: the 60KB output is replaced by a truncated preview + managed path.
    expect(result.summaryMessage.recent).toContain("[Managed output: /managed/build-output.log]")
    expect(result.summaryMessage.recent).toContain("[truncated]")
    expect(result.summaryMessage.recent).toContain(BIG_PREFIX.trim())
    expect(result.summaryMessage.recent).not.toContain(BIG_SUFFIX)

    // Protection tag: the errored tool result survives microcompact verbatim.
    expect(result.summaryMessage.recent).toContain(TAGGED_ERROR)

    // Cleared ids map back to SessionMessage tool part ids (the -result suffix stripped).
    expect(result.clearedPartIds).toEqual(["p_r1", "p_r2", "p_r4", "p_r6"])

    // The typed checkpoint carries the summary and a recentTailStartId referencing an existing message.
    expect(result.checkpoint.objective).toBe(SUMMARY)
    expect(result.checkpoint.recentTailStartId).toBe("msg_u11")
    expect(fixture.some((item) => item.message.id === result.checkpoint.recentTailStartId)).toBe(true)
  })

  test("the summarize seam requests a typed JSON checkpoint so production structured fields are populated", async () => {
    const requests: LLMRequest[] = []
    const llm = {
      stream: (request: LLMRequest) => {
        requests.push(request)
        return Stream.succeed(LLMEvent.textDelta({ id: "c1", text: SUMMARY }))
      },
    }
    const result = await Effect.runPromise(
      SessionCompaction.CompactionPipeline.run(
        { llm, config: [configDocument(undefined, 20_000)] },
        pipelineInput,
      ),
    )

    expect(result).toBeDefined()
    expect(requests).toHaveLength(1)
    const prompt = requests[0]?.messages.flatMap((message) =>
      message.role === "user" ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
    ).join("\n")
    expect(prompt).toContain("JSON checkpoint")
    expect(prompt).toContain("objective (string)")
  })
})

const live = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])),
)

describe("compactIfNeeded", () => {
  live.effect("routes through the pipeline exactly once when the preflight signals compaction", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      let calls = 0
      const llm = {
        stream: (request: LLMRequest) => {
          calls++
          return Stream.succeed(LLMEvent.textDelta({ id: "c1", text: SUMMARY }))
        },
      }
      const compaction = SessionCompaction.make({
        events,
        llm,
        config: [configDocument(0, 10)],
      })
      const nearFullModel = Model.make({
        id: "test-model",
        provider: "openai",
        route: OpenAIChat.route.with({ limits: { context: 1_000, output: 100 } }),
      })
      const request = LLM.request({ model: nearFullModel, messages: [Message.user("t".repeat(5_000))], tools: [] })
      const input = {
        sessionID: SessionSchema.ID.make("ses_overflow_test"),
        entries: [
          entry(1, user("u1", "Hello")),
          entry(2, assistant("a1", [textPart("t1", "Hi there")])),
          entry(3, user("u2", "Build it")),
        ],
        model: nearFullModel,
        request,
        contextEpoch: 0,
      }

      const compacted = yield* compaction.compactIfNeeded(input)

      expect(compacted).toBe(true)
      expect(calls).toBe(1)
    }),
  )

  live.effect("does not compact when the summarizer stream errors after partial output", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      let calls = 0
      const llm = {
        stream: (request: LLMRequest) => {
          calls++
          return Stream.concat(
            Stream.succeed(LLMEvent.textDelta({ id: "c1", text: "partial summary" })),
            Stream.fail(
              new LLMError({ module: "test", method: "stream", reason: new InvalidRequestReason({ message: "boom" }) }),
            ),
          )
        },
      }
      const compaction = SessionCompaction.make({
        events,
        llm,
        config: [configDocument(0, 10)],
      })
      const nearFullModel = Model.make({
        id: "test-model",
        provider: "openai",
        route: OpenAIChat.route.with({ limits: { context: 1_000, output: 100 } }),
      })
      const request = LLM.request({ model: nearFullModel, messages: [Message.user("t".repeat(5_000))], tools: [] })
      const input = {
        sessionID: SessionSchema.ID.make("ses_overflow_error_test"),
        entries: [
          entry(1, user("u1", "Hello")),
          entry(2, assistant("a1", [textPart("t1", "Hi there")])),
          entry(3, user("u2", "Build it")),
        ],
        model: nearFullModel,
        request,
        contextEpoch: 0,
      }

      const compacted = yield* compaction.compactIfNeeded(input)

      expect(compacted).toBe(false)
      expect(calls).toBe(1)
    }),
  )
})
