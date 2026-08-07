import { describe, expect } from "bun:test"
import { DateTime, Effect, Stream } from "effect"
import type { LLMRequest } from "@opencode-ai/llm"
import { LLM, LLMEvent, Message, Model, ToolDefinition } from "@opencode-ai/llm"
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
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
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

const SESSION_ID = SessionSchema.ID.make("ses_snapshot_test")

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

const fixture = [
  entry(1, SessionMessage.Compaction.make({
    id: messageID("prev"),
    type: "compaction",
    reason: "auto",
    summary: "Old summary",
    recent: "Old recent",
    time: { created },
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

// The pre-compaction provider-request context the snapshot must capture
// unmutated: non-empty system, messages, and tools make the deep-equal
// assertion meaningful.
const request = LLM.request({
  model,
  system: [{ type: "text", text: "You are the build assistant" }],
  messages: [Message.user("t".repeat(5_000)), Message.assistant("prior response")],
  tools: [ToolDefinition.make({ name: "read", description: "Read a file", inputSchema: {} })],
})

const overflowInput = {
  sessionID: SESSION_ID,
  entries: fixture,
  model,
  request,
  contextEpoch: 7,
}

const configDocument = (snapshot?: boolean) =>
  new Config.Document({
    type: "document",
    info: new Config.Info({
      compaction: new ConfigCompaction.Info(snapshot === undefined ? {} : { snapshot }),
    }),
  })

const scriptedStream = (text: string) => (request: LLMRequest) =>
  Stream.succeed(LLMEvent.textDelta({ id: "c1", text }))

const live = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])),
)

describe("pre-compaction context snapshots", () => {
  live.effect("persists the unmutated request context and stamps Compaction.Started with the sha", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const started: SessionEvent.Compaction.Started[] = []
      yield* events.project(SessionEvent.Compaction.Started, (event) =>
        Effect.sync(() => {
          started.push(event)
        }),
      )
      const store = new CompactionCheckpointStore.InMemoryCompactionCheckpointStore()
      const compaction = SessionCompaction.make({
        events,
        llm: { stream: scriptedStream(CHECKPOINT_JSON) },
        config: [configDocument(true)],
        checkpointStore: store,
      })

      const compacted = yield* compaction.compactAfterOverflow(overflowInput)

      expect(compacted).toBe(true)
      expect(started).toHaveLength(1)
      const sha = started[0].metadata?.preCompactionSnapshotSha
      expect(typeof sha).toBe("string")
      expect(started[0].metadata?.snapshotLost).toBeUndefined()

      const stored = store.retrieveSnapshot(sha as string)
      expect(stored).toBeDefined()
      const body = JSON.parse(stored as string) as { system: unknown; messages: unknown; tools: unknown }
      expect(body).toEqual({ system: request.system, messages: request.messages, tools: request.tools })
    }),
  )

  live.effect("marks snapshotLost and compaction still succeeds when the snapshot write fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const started: SessionEvent.Compaction.Started[] = []
      yield* events.project(SessionEvent.Compaction.Started, (event) =>
        Effect.sync(() => {
          started.push(event)
        }),
      )
      const backing = new CompactionCheckpointStore.InMemoryCompactionCheckpointStore()
      const failingStore: CompactionCheckpointStore.Interface = {
        put: (input) => backing.put(input),
        putSnapshot: () => Effect.fail(new Error("snapshot store unavailable")),
      }
      const compaction = SessionCompaction.make({
        events,
        llm: { stream: scriptedStream(CHECKPOINT_JSON) },
        config: [configDocument(true)],
        checkpointStore: failingStore,
      })

      const compacted = yield* compaction.compactAfterOverflow(overflowInput)

      expect(compacted).toBe(true)
      expect(started).toHaveLength(1)
      expect(started[0].metadata?.snapshotLost).toBe(true)
      expect(started[0].metadata?.preCompactionSnapshotSha).toBeUndefined()
    }),
  )

  live.effect("marks snapshotLost when snapshot is enabled but no store is wired", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const started: SessionEvent.Compaction.Started[] = []
      yield* events.project(SessionEvent.Compaction.Started, (event) =>
        Effect.sync(() => {
          started.push(event)
        }),
      )
      const compaction = SessionCompaction.make({
        events,
        llm: { stream: scriptedStream(CHECKPOINT_JSON) },
        config: [configDocument(true)],
      })

      const compacted = yield* compaction.compactAfterOverflow(overflowInput)

      expect(compacted).toBe(true)
      expect(started).toHaveLength(1)
      expect(started[0].metadata?.snapshotLost).toBe(true)
      expect(started[0].metadata?.preCompactionSnapshotSha).toBeUndefined()
    }),
  )

  live.effect("does not snapshot when compaction.snapshot is unset", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const started: SessionEvent.Compaction.Started[] = []
      yield* events.project(SessionEvent.Compaction.Started, (event) =>
        Effect.sync(() => {
          started.push(event)
        }),
      )
      const store = new CompactionCheckpointStore.InMemoryCompactionCheckpointStore()
      const compaction = SessionCompaction.make({
        events,
        llm: { stream: scriptedStream(CHECKPOINT_JSON) },
        config: [configDocument()],
        checkpointStore: store,
      })

      const compacted = yield* compaction.compactAfterOverflow(overflowInput)

      expect(compacted).toBe(true)
      expect(started).toHaveLength(1)
      expect(started[0].metadata?.preCompactionSnapshotSha).toBeUndefined()
      expect(started[0].metadata?.snapshotLost).toBeUndefined()
      expect(store.snapshotCount).toBe(0)
    }),
  )
})
