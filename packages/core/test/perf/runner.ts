// Recorded-runner measurements for the perf baseline harness (perf/baseline.ts).
// Mirrors the layer stack from session-runner-recorded.test.ts; the cassette is
// replayed from a fresh Effect scope per sample so each run consumes the single
// recorded interaction. perf/baseline.ts forces an in-memory core database before
// importing this module so the baseline never touches the on-disk database.

import { HttpRecorder } from "@opencode-ai/http-recorder"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { Auth, LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Location } from "@opencode-ai/core/location"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import path from "node:path"

const PROMPT = Prompt.make({ text: "Say hello in one short sentence." })

const PROMPT_TIMEOUT = "30 seconds"

export const measureTTFT = async (runs: number): Promise<number[]> => {
  const samples: number[] = []
  for (let run = 0; run < runs; run++) {
    samples.push(await runTTFTSample(SessionV2.ID.make(`ses_baseline_${run}`)))
  }
  return samples
}

export const measureIdleMemory = async (runs: number): Promise<number[]> => {
  const samples: number[] = []
  for (let run = 0; run < runs; run++) {
    await Bun.sleep(200)
    samples.push(process.memoryUsage().rss / 2 ** 20)
  }
  return samples
}

const runTTFTSample = (sessionID: SessionV2.ID) =>
  runScoped(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSession(db, sessionID)
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const deferred = yield* Deferred.make<number>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.gen(function* () {
          if (event.type === SessionEvent.Text.Delta.type && (event.data as { sessionID: string }).sessionID === sessionID) {
            yield* Deferred.succeed(deferred, Date.now())
          }
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const promptAdmitted = Date.now()
      yield* session.prompt({ sessionID, prompt: PROMPT, resume: false })
      const resumeFiber = yield* session.resume(sessionID).pipe(Effect.forkChild)
      const arrived = yield* Deferred.await(deferred).pipe(Effect.timeout(PROMPT_TIMEOUT))
      yield* Fiber.join(resumeFiber)
      return arrived - promptAdmitted
    }),
    layer,
  )

const runScoped = <A, E, R, E2>(sample: Effect.Effect<A, E, R | Scope.Scope>, testLayer: Layer.Layer<R, E2>) =>
  Effect.gen(function* () {
    const exit = yield* sample.pipe(Effect.scoped, Effect.provide(testLayer), Effect.exit)
    return yield* Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)
  }).pipe(Effect.runPromise)

const seedSession = (
  db: Database.Interface["db"],
  sessionID: SessionV2.ID,
) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const cassette = HttpRecorder.http("session-runner/openai-chat-streams-text", {
  directory: path.resolve(import.meta.dir, "../fixtures/recordings"),
})
const executor = RequestExecutor.layer.pipe(Layer.provide(cassette))
const client = LLMClient.layer.pipe(Layer.provide(executor))
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
const model = OpenAIChat.route
  .with({
    endpoint: { baseURL: "https://api.openai.com/v1" },
    auth: Auth.bearer(process.env.OPENAI_API_KEY ?? "fixture"),
    generation: { maxTokens: 20, temperature: 0 },
  })
  .model({ id: "gpt-4o-mini" })
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
const systemContext = AppNodeBuilder.build(SystemContextRegistry.node)
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [Config.node, config],
  [PermissionV2.node, permission],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
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
const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    SessionProjector.node,
    SessionStore.node,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    SessionRunnerLLM.node,
    SessionV2.node,
  ]),
  [
    [LayerNodePlatform.llmClient, client],
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [SessionRunnerModel.node, models],
    [SystemContextRegistry.node, systemContext],
    [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
    [SkillGuidance.node, skillGuidance],
    [ReferenceGuidance.node, referenceGuidance],
    [Config.node, config],
    [Snapshot.node, Snapshot.noopLayer],
    [SessionExecution.node, execution],
  ],
)
