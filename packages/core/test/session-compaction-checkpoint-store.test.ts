import { describe, expect } from "bun:test"
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
import { CompactionCheckpointStore } from "@opencode-ai/core/session/compaction-checkpoint-store"
import { parseCheckpoint } from "@opencode-ai/core/session/compaction-summarize"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { Planner } from "@ultracode/context"
import { testEffect } from "./lib/effect"

const created = DateTime.makeUnsafe(0)
const messageID = (value: string) => SessionMessage.ID.make(`msg_${value}`)
const modelRef = { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("openai") }
const assistantTime = { created, completed: created }

const user = (n: string, text: string) => SessionMessage.User.make({ id: messageID(n), type: "user", text, time: { created } })
const textPart = (n: string, t: string) => SessionMessage.AssistantText.make({ type: "text", id: `p_${n}`, text: t })
const assistant = (n: string, content: SessionMessage.AssistantContent[]) =>
  SessionMessage.Assistant.make({ id: messageID(n), type: "assistant", agent: "build", model: modelRef, content, time: assistantTime })
const entry = (seq: number, message: SessionMessage.Message) => ({ seq, message })

const PARENT_SHA = "a".repeat(64)
const SESSION_ID = SessionSchema.ID.make("ses_checkpoint_store_test")

const CHECKPOINT_JSON = JSON.stringify({
  objective: "The project builds and the test suite passes",
  completed: ["ran the build", "ran the test suite"],
  constraints: [],
  decisions: [],
  workingSet: [],
  facts: [],
  toolArtifacts: [],
  tests: [],
  errors: [],
  pending: [],
  approvalState: [],
  agentLineage: [],
})

// A compact history anchored by a previous compaction that carried a
// checkpointSha, so the controller can chain parent_compaction_sha.
const fixture = [
  entry(1, SessionMessage.Compaction.make({
    id: messageID("prev"),
    type: "compaction",
    reason: "auto",
    summary: "Old summary",
    recent: "Old recent",
    time: { created },
    metadata: { checkpointSha: PARENT_SHA },
  })),
  entry(2, user("u1", "Build the project")),
  entry(3, assistant("a1", [textPart("t1", "Build succeeded")])),
  entry(4, user("u2", "Run the tests")),
]

const model = Model.make({
  id: "test-model",
  provider: "openai",
  route: OpenAIChat.route.with({ limits: { context: 1_000, output: 100 } }),
})

const request = LLM.request({ model, messages: [Message.user("t".repeat(5_000))], tools: [] })

const overflowInput = {
  sessionID: SESSION_ID,
  entries: fixture,
  model,
  request,
  contextEpoch: 7,
}

const configDocument = (tokens?: number) =>
  new Config.Document({
    type: "document",
    info: new Config.Info({
      compaction: new ConfigCompaction.Info({
        ...(tokens === undefined ? {} : { keep: new ConfigCompaction.Keep({ tokens }) }),
      }),
    }),
  })

const scriptedStream = (text: string) => (request: LLMRequest) =>
  Stream.succeed(LLMEvent.textDelta({ id: "c1", text }))

type StoredCheckpoint = {
  readonly checkpoint: Planner.CompactionCheckpoint
  readonly context_epoch: number
  readonly session_id: string
  readonly parent_compaction_sha?: string
}

const live = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])),
)

describe("CompactionCheckpointStore", () => {
  live.effect("persists the typed checkpoint and stamps the Compaction message metadata", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const captured: SessionEvent.Compaction.Ended[] = []
      yield* events.project(SessionEvent.Compaction.Ended, (event) =>
        Effect.sync(() => {
          captured.push(event)
        }),
      )
      const store = new CompactionCheckpointStore.InMemoryCompactionCheckpointStore()
      const compaction = SessionCompaction.make({
        events,
        llm: { stream: scriptedStream(CHECKPOINT_JSON) },
        config: [configDocument(10)],
        checkpointStore: store,
      })

      const compacted = yield* compaction.compactAfterOverflow(overflowInput)

      expect(compacted).toBe(true)
      expect(captured).toHaveLength(1)
      const ended = captured[0]
      const checkpointSha =
        typeof ended.metadata?.checkpointSha === "string" ? ended.metadata.checkpointSha : undefined
      expect(checkpointSha).toBeDefined()
      expect(ended.metadata?.checkpointLost).toBeUndefined()

      const canonical = store.retrieve(checkpointSha as string)
      expect(canonical).toBeDefined()
      const stored = JSON.parse(canonical as string) as StoredCheckpoint
      expect(stored.session_id).toBe(SESSION_ID)
      expect(stored.context_epoch).toBe(7)
      expect(stored.parent_compaction_sha).toBe(PARENT_SHA)

      const roundTripped = parseCheckpoint(JSON.stringify(stored.checkpoint))
      expect(roundTripped?.objective).toBe(stored.checkpoint.objective)
      expect(roundTripped?.completed).toEqual(stored.checkpoint.completed)
      expect(roundTripped?.recentTailStartId).toBe(stored.checkpoint.recentTailStartId)
    }),
  )

  live.effect("marks checkpointLost when the store fails and compaction still succeeds", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const captured: SessionEvent.Compaction.Ended[] = []
      yield* events.project(SessionEvent.Compaction.Ended, (event) =>
        Effect.sync(() => {
          captured.push(event)
        }),
      )
      const failingStore: CompactionCheckpointStore.Interface = {
        put: () => Effect.fail(new Error("store unavailable")),
      }
      const compaction = SessionCompaction.make({
        events,
        llm: { stream: scriptedStream(CHECKPOINT_JSON) },
        config: [configDocument(10)],
        checkpointStore: failingStore,
      })

      const compacted = yield* compaction.compactAfterOverflow(overflowInput)

      expect(compacted).toBe(true)
      expect(captured).toHaveLength(1)
      const ended = captured[0]
      expect(ended.metadata?.checkpointLost).toBe(true)
      expect(ended.metadata?.checkpointSha).toBeUndefined()
    }),
  )

  live.effect("marks checkpointLost when no store is wired and compaction still succeeds", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const captured: SessionEvent.Compaction.Ended[] = []
      yield* events.project(SessionEvent.Compaction.Ended, (event) =>
        Effect.sync(() => {
          captured.push(event)
        }),
      )
      const compaction = SessionCompaction.make({
        events,
        llm: { stream: scriptedStream(CHECKPOINT_JSON) },
        config: [configDocument(10)],
      })

      const compacted = yield* compaction.compactAfterOverflow(overflowInput)

      expect(compacted).toBe(true)
      expect(captured).toHaveLength(1)
      const ended = captured[0]
      expect(ended.metadata?.checkpointLost).toBe(true)
      expect(ended.metadata?.checkpointSha).toBeUndefined()
    }),
  )
})
