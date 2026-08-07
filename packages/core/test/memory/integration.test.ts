import { describe, expect } from "bun:test"
import { InMemoryMemoryStore, type MemoryRecord } from "@ultracode/memory"
import {
  LLMClient,
  LLMEvent,
  Model,
  type LLMClientShape,
  type LLMRequest,
} from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigMemory } from "@opencode-ai/core/config/memory"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { InstructionContext } from "@opencode-ai/core/instruction-context"
import { Location } from "@opencode-ai/core/location"
import { MemorySource } from "@opencode-ai/core/memory/source"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect, Layer, Stream } from "effect"
import { testEffect } from "../lib/effect"

const now = Date.now()
const DAY = 86_400_000

const requests: LLMRequest[] = []
let response: LLMEvent[] = []

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      return Stream.fromIterable(response)
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: () => Effect.succeed(SystemContext.empty),
})
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, {
  load: () => Effect.succeed(SystemContext.empty),
})

const store = new InMemoryMemoryStore()
const storeLayer = Layer.succeed(MemorySource.MemoryStoreService, MemorySource.MemoryStoreService.of(store))

const configWithMemory = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({ memory: new ConfigMemory.Info({ enabled: true }) }),
        }),
      ]),
  }),
)

const configWithoutMemory = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({}),
        }),
      ]),
  }),
)

const memoryNode = LayerNode.group([
  Database.node,
  EventV2.node,
  QuestionV2.node,
  SessionProjector.node,
  SessionStore.node,
  ApplicationTools.node,
  AgentV2.node,
  ToolRegistry.node,
  ToolRegistry.toolsNode,
  SessionRunnerModel.node,
  SystemContextRegistry.node,
  SkillGuidance.node,
  ReferenceGuidance.node,
  Config.node,
  Snapshot.node,
  SessionRunnerLLM.node,
  SessionExecution.node,
  SessionV2.node,
  MemorySource.node,
])

const record = (threadId: string, over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  threadId,
  sourceUpdatedAt: now,
  rawMemory: "raw",
  rolloutSummary: "",
  cwd: "/project",
  generatedAt: now,
  usageCount: 0,
  ...over,
})

const makeIt = (config: Layer.Layer<Config.Service>) => {
  const execution = Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const sessionRunner = yield* SessionRunner.Service
      const coordinator = yield* SessionRunCoordinator.make<
        SessionV2.ID,
        SessionRunner.RunError,
        SessionRunner.RunResult,
        SessionRunner.Limits
      >({
        drain: (sessionID, force, limits) => sessionRunner.run({ sessionID, force, limits }),
      })
      return SessionExecution.Service.of({
        active: coordinator.active,
        resume: (sessionID) => coordinator.run(sessionID).pipe(Effect.asVoid),
        wake: coordinator.wake,
        interrupt: coordinator.interrupt,
        supervise: (input) => SessionExecution.supervise(coordinator, input),
      })
    }),
  )
  return testEffect(
    AppNodeBuilder.build(memoryNode, [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
      [MemorySource.memoryStoreNode, storeLayer],
      [InstructionContext.node, Layer.effectDiscard(Effect.void)],
    ]),
  )
}

const it = makeIt(configWithMemory)
const disabledIt = makeIt(configWithoutMemory)

const setup = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    requests.length = 0
    response = []
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id, project_id: Project.ID.global, slug: id, directory: "/project", title: "test", version: "test" })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const systemTexts = (request: LLMRequest | undefined) => request?.system.map((part) => part.text).join("\n") ?? ""

const runOneTurn = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "First" }), resume: false })
    response = [
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.textStart({ id: "text-1" }),
      LLMEvent.textDelta({ id: "text-1", text: "Done" }),
      LLMEvent.textEnd({ id: "text-1" }),
      LLMEvent.stepFinish({ index: 0, reason: "stop" }),
      LLMEvent.finish({ reason: "stop" }),
    ]
    yield* session.resume(id)
  })

describe("memory runner integration", () => {
  const sessionID = SessionV2.ID.make("ses_memory_enabled")

  it.effect("injects memory into the provider system prompt when memory.enabled", () =>
    Effect.gen(function* () {
      yield* setup(sessionID)
      yield* Effect.promise(() =>
        store.upsert(record("t1", { rawMemory: "Refactor helper naming", sourceUpdatedAt: now - DAY })),
      )
      yield* Effect.promise(() =>
        store.upsert(record("t2", { rawMemory: "Deploy key sk-abcdefghijklmnop", sourceUpdatedAt: now })),
      )
      yield* runOneTurn(sessionID)

      expect(requests).toHaveLength(1)
      const system = systemTexts(requests[0])
      expect(system).toMatch(/## Memory/)
      expect(system).toContain("[REDACTED]")
    }),
  )

  const disabledID = SessionV2.ID.make("ses_memory_disabled")

  disabledIt.effect("omits memory from the provider system prompt when memory.enabled is absent", () =>
    Effect.gen(function* () {
      yield* setup(disabledID)
      yield* Effect.promise(() =>
        store.upsert(record("t1", { rawMemory: "Refactor helper naming", sourceUpdatedAt: now - DAY })),
      )
      yield* Effect.promise(() =>
        store.upsert(record("t2", { rawMemory: "Deploy key sk-abcdefghijklmnop", sourceUpdatedAt: now })),
      )
      yield* runOneTurn(disabledID)

      expect(requests).toHaveLength(1)
      const system = systemTexts(requests[0])
      expect(system).not.toMatch(/## Memory/)
    }),
  )
})
