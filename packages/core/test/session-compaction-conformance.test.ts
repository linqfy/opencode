import { describe, expect, test } from "bun:test"
import path from "node:path"
import { LLM, LLMClient, LLMEvent, Message, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { ModelV2 } from "@opencode-ai/core/model"
import { Location } from "@opencode-ai/core/location"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Token } from "@opencode-ai/core/util/token"
import { Planner } from "@ultracode/context"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

const fixturesDir = path.join(import.meta.dir, "fixtures", "compaction")
const loadFixture = async <T>(name: string): Promise<T> =>
  (await Bun.file(path.join(fixturesDir, name)).json()) as unknown as T

// ---------------------------------------------------------------------------
// Scenario 1 harness: the real SessionRunnerLLM node with a fake llm.stream,
// mirroring session-runner.test.ts so the runner's overflow control flow runs.
// ---------------------------------------------------------------------------

const requests: LLMRequest[] = []
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      return Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const baseModel = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
let currentModel = baseModel
const models = SessionRunnerModel.layerWith((session) => Effect.succeed(currentModel))
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
const systemContextKey = SystemContext.Key.make("test/context")
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.sync(() =>
          SystemContext.combine([
            SystemContext.make({
              key: systemContextKey,
              codec: Schema.toCodecJson(Schema.String),
              load: Effect.succeed("Initial context"),
              baseline: String,
              update: (_previous, current) => current,
              removed: () => "System context source removed: test/context",
            }),
          ]),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))
const skillGuidance = Layer.succeed(
  SkillGuidance.Service,
  SkillGuidance.Service.of({ load: () => Effect.succeed(SystemContext.empty) }),
)
const referenceGuidance = Layer.succeed(
  ReferenceGuidance.Service,
  ReferenceGuidance.Service.of({ load: () => Effect.succeed(SystemContext.empty) }),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
)
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [PermissionV2.node, permission],
  [Config.node, config],
])
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
).pipe(Layer.provide(runnerLayer))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
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
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
    ],
  ),
)

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setupRunner = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    response = []
    responses = undefined
    currentModel = baseModel
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* insertSession(id)
  })

type OverflowStep = { readonly kind: "overflow"; readonly message: string } | { readonly kind: "summary"; readonly text: string }
type OverflowFixture = {
  readonly sessionID: string
  readonly model: { readonly id: string; readonly context: number; readonly output: number }
  readonly history: { readonly prompt: string; readonly response: string }
  readonly runPrompt: string
  readonly script: readonly OverflowStep[]
}

const overflowEvents = (message: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.providerError({ message, classification: "context-overflow" }),
]
const textEvents = (chunks: readonly string[]) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text" }),
  ...chunks.map((text) => LLMEvent.textDelta({ id: "text", text })),
  LLMEvent.textEnd({ id: "text" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]
const scriptedEvents = (step: OverflowStep) => (step.kind === "overflow" ? overflowEvents(step.message) : textEvents([step.text]))
const userTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "user" ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
  )
const isSummaryRequest = (request: LLMRequest) => userTexts(request).some((text) => text.includes("anchored summary"))

describe("scenario 1: overflow exactly once, then terminal", () => {
  it.effect("the runner compacts once and never recompacts the second overflow", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => loadFixture<OverflowFixture>("overflow-once-then-terminal.json"))
      const session = yield* SessionV2.Service
      const sessionID = SessionV2.ID.make(fixture.sessionID)
      yield* setupRunner(sessionID)
      currentModel = Model.make({
        id: fixture.model.id,
        provider: "fake",
        route: OpenAIChat.route.with({ limits: { context: fixture.model.context, output: fixture.model.output } }),
      })
      response = textEvents([fixture.history.response])
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: fixture.history.prompt }), resume: false })
      yield* session.resume(sessionID)
      requests.length = 0
      responses = fixture.script.map(scriptedEvents)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: fixture.runPrompt }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(requests.filter(isSummaryRequest)).toHaveLength(1)
      const context = yield* session.context(sessionID)
      expect(context.filter((message) => message.type === "compaction")).toHaveLength(1)
      expect(context.at(-1)).toMatchObject({
        type: "assistant",
        finish: "error",
        error: { message: "prompt too long" },
      })
    }),
  )
})

// ---------------------------------------------------------------------------
// Scenarios 2-5: drive the controller/pipeline directly with scripted fixtures.
// ---------------------------------------------------------------------------

type TaggedPlannerPart = {
  readonly id: string
  readonly kind: "tool_result"
  readonly text: string
  readonly tokens: number
  readonly toolName?: string
  readonly userAuthored?: boolean
  readonly permissionOrConstraint?: boolean
  readonly invokedSkill?: boolean
  readonly currentTask?: boolean
  readonly activeFailure?: boolean
}
type TagProtectionFixture = {
  readonly conversation: readonly {
    readonly id: string
    readonly role: Planner.PlannerRole
    readonly tokens: number
    readonly parts: readonly TaggedPlannerPart[]
  }[]
}

const EMPTY_CHECKPOINT: Planner.CompactionCheckpoint = {
  objective: "Summarized",
  completed: [],
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
}

const PROTECTED_IDS = ["tag-u", "tag-p", "tag-i", "tag-c", "tag-f"]
const CLEARED_IDS = ["plain-1", "plain-2"]

describe("scenario 2: tag protection", () => {
  test("every protected part survives microcompact verbatim and only untagged parts are cleared", async () => {
    const fixture = await loadFixture<TagProtectionFixture>("tag-protection.json")
    const messages: Planner.PlannerMessage[] = fixture.conversation.map((message) => ({
      id: message.id,
      role: message.role,
      tokens: message.tokens,
      parts: message.parts.map((part) => ({ ...part })),
    }))
    const compacted = await Planner.compactConversation(messages, Planner.DEFAULT_COMPACTION_CONFIG, {
      artifactPreview: (part) => part,
      summarize: () => EMPTY_CHECKPOINT,
    })
    const surviving = new Map(
      compacted.messages.flatMap((message) => message.parts.map((part) => [part.id, part.text] as const)),
    )
    for (const id of PROTECTED_IDS) {
      const original = messages.flatMap((message) => message.parts).find((part) => part.id === id)
      expect(surviving.get(id)).toBe(original?.text)
    }
    expect(compacted.clearedPartIds).toEqual(CLEARED_IDS)
    for (const id of CLEARED_IDS) expect(surviving.get(id)).toBe(Planner.CLEARED_MESSAGE)
  })
})

type FixtureToolState =
  | {
      readonly status: "completed"
      readonly input: Record<string, unknown>
      readonly content: readonly { readonly type: "text"; readonly text: string }[]
      readonly structured: Record<string, unknown>
      readonly outputPaths?: readonly string[]
    }
  | {
      readonly status: "error"
      readonly input: Record<string, unknown>
      readonly content: readonly unknown[]
      readonly structured: Record<string, unknown>
      readonly error: { readonly type: "unknown"; readonly message: string }
    }
type FixtureAssistantContent =
  | { readonly type: "text"; readonly id: string; readonly text: string }
  | { readonly type: "tool"; readonly id: string; readonly name: string; readonly state: FixtureToolState; readonly time: { readonly created: number; readonly completed: number } }
type FixtureMessage =
  | { readonly type: "user"; readonly id: string; readonly text: string; readonly time: number }
  | { readonly type: "compaction"; readonly id: string; readonly reason: "auto"; readonly summary: string; readonly recent: string; readonly time: number }
  | {
      readonly type: "assistant"
      readonly id: string
      readonly agent: string
      readonly model: { readonly id: string; readonly providerID: string }
      readonly content: readonly FixtureAssistantContent[]
      readonly time: { readonly created: number; readonly completed: number }
    }
type PipelineFixture = {
  readonly tokens: number
  readonly summary: string
  readonly entries: readonly { readonly seq: number; readonly message: FixtureMessage }[]
}

const messageID = (value: string) => SessionMessage.ID.make(value)
const modelRef = (id: string, providerID: string) => ({ id: ModelV2.ID.make(id), providerID: ProviderV2.ID.make(providerID) })
const instant = (millis: number) => DateTime.makeUnsafe(millis)

const toToolState = (state: FixtureToolState): SessionMessage.ToolState => {
  if (state.status === "completed")
    return SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input: state.input,
      content: state.content,
      structured: state.structured,
      ...(state.outputPaths === undefined ? {} : { outputPaths: state.outputPaths }),
    })
  return SessionMessage.ToolStateError.make({
    status: "error",
    input: state.input,
    content: [],
    structured: state.structured,
    error: state.error,
  })
}

const toAssistantContent = (part: FixtureAssistantContent): SessionMessage.AssistantContent => {
  if (part.type === "text") return SessionMessage.AssistantText.make({ type: "text", id: part.id, text: part.text })
  return SessionMessage.AssistantTool.make({
    type: "tool",
    id: part.id,
    name: part.name,
    state: toToolState(part.state),
    time: { created: instant(part.time.created), completed: instant(part.time.completed) },
  })
}

const toSessionMessage = (message: FixtureMessage): SessionMessage.Message => {
  if (message.type === "user")
    return SessionMessage.User.make({ id: messageID(message.id), type: "user", text: message.text, time: { created: instant(message.time) } })
  if (message.type === "compaction")
    return SessionMessage.Compaction.make({ id: messageID(message.id), type: "compaction", reason: message.reason, summary: message.summary, recent: message.recent, time: { created: instant(message.time) } })
  return SessionMessage.Assistant.make({
    id: messageID(message.id),
    type: "assistant",
    agent: message.agent,
    model: modelRef(message.model.id, message.model.providerID),
    content: message.content.map(toAssistantContent),
    time: { created: instant(message.time.created), completed: instant(message.time.completed) },
  })
}

const configDocument = (tokens: number) =>
  new Config.Document({
    type: "document",
    info: new Config.Info({
      compaction: new ConfigCompaction.Info({ keep: new ConfigCompaction.Keep({ tokens }) }),
    }),
  })

const model = (cacheEdit?: boolean) =>
  Model.make({
    id: "test-model",
    provider: "openai",
    route: OpenAIChat.route.with({ limits: { context: 200_000, output: 4_096 } }),
    ...(cacheEdit === undefined ? {} : { compatibility: { cacheEdit } }),
  })

const runPipeline = async (fixture: PipelineFixture, cacheEdit?: boolean) => {
  const summaries: LLMRequest[] = []
  const llm = {
    stream: (request: LLMRequest) => {
      summaries.push(request)
      return Stream.succeed(LLMEvent.textDelta({ id: "c1", text: fixture.summary }))
    },
  }
  const m = model(cacheEdit)
  const result = await Effect.runPromise(
    SessionCompaction.CompactionPipeline.run(
      { llm, config: [configDocument(fixture.tokens)] },
      {
        sessionID: SessionSchema.ID.make("ses_conformance_pipeline"),
        entries: fixture.entries.map((item) => ({ seq: item.seq, message: toSessionMessage(item.message) })),
        model: m,
        request: LLM.request({ model: m, messages: [Message.user("continue")], tools: [] }),
        contextEpoch: 0,
      },
    ),
  )
  return { result, summaries }
}

describe("scenario 3: tail-keep within ±10% of compaction.keep.tokens", () => {
  test("the kept recent tail lands in the configured keep-token band", async () => {
    const fixture = await loadFixture<PipelineFixture>("tail-keep.json")
    const { result } = await runPipeline(fixture)
    expect(result).toBeDefined()
    if (result === undefined) return
    const tokens = Token.estimate(result.summaryMessage.recent)
    expect(tokens).toBeGreaterThanOrEqual(Math.floor(fixture.tokens * 0.9))
    expect(tokens).toBeLessThanOrEqual(Math.ceil(fixture.tokens * 1.1))
  })
})

const NEXT_STEP = "Next, run `bun test`"

describe("scenario 4: verbatim next-step quote", () => {
  test("the next-step quote reaches the summarizer prompt and the durable summary verbatim", async () => {
    const fixture = await loadFixture<PipelineFixture>("verbatim-next-step.json")
    const { result, summaries } = await runPipeline(fixture)
    expect(result).toBeDefined()
    if (result === undefined) return
    expect(summaries).toHaveLength(1)
    expect(userTexts(summaries[0]).join("\n")).toContain(NEXT_STEP)
    expect(result.summaryMessage.summary).toContain(NEXT_STEP)
  })
})

describe("scenario 5: cache-edit vs mutation parity", () => {
  test("both routes produce identical durable cleared state, differing only on the wire", async () => {
    const fixture = await loadFixture<PipelineFixture>("cache-edit-parity.json")
    const mutation = await runPipeline(fixture, false)
    const cacheEdit = await runPipeline(fixture, true)

    expect(mutation.result).toBeDefined()
    expect(cacheEdit.result).toBeDefined()
    if (mutation.result === undefined || cacheEdit.result === undefined) return

    expect(mutation.result.cacheEdit).toBeUndefined()
    expect(cacheEdit.result.cacheEdit).toEqual({ kind: "cache-edit", partIds: cacheEdit.result.clearedPartIds })
    expect(cacheEdit.result.clearedPartIds.length).toBeGreaterThan(0)

    expect(cacheEdit.result.clearedPartIds).toEqual(mutation.result.clearedPartIds)
    expect(cacheEdit.result.summaryMessage.reason).toEqual(mutation.result.summaryMessage.reason)
    expect(cacheEdit.result.summaryMessage.summary).toEqual(mutation.result.summaryMessage.summary)
    expect(cacheEdit.result.summaryMessage.recent).toEqual(mutation.result.summaryMessage.recent)
    expect(cacheEdit.result.checkpoint).toEqual(mutation.result.checkpoint)
  })
})
