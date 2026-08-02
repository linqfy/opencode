import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [[Location.node, current]],
  ),
)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

function profile(input: Partial<PermissionV2.Profile> = {}) {
  return {
    name: "restricted",
    version: "1",
    rules: [],
    ...input,
  } satisfies PermissionV2.Profile
}

function waitForRequest(input = assertion()) {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(input).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("PermissionV2", () => {
  it.effect("resolves named profile versions and preserves parent ask and deny rules", () =>
    Effect.sync(() => {
    const profiles = [
      profile({
        name: "base",
        version: "3",
        rules: [
          { action: "read", resource: "secret/*", effect: "deny" },
          { action: "bash", resource: "*", effect: "ask" },
        ],
      }),
      profile({
        name: "restricted",
        version: "4",
        parent: "base",
        rules: [
          { action: "read", resource: "secret/*", effect: "allow" },
          { action: "bash", resource: "*", effect: "allow" },
        ],
      }),
    ]

    const resolved = PermissionV2.resolveProfile("restricted", profiles)
    expect(resolved?.version).toBe("4")
    expect(PermissionV2.evaluate("read", "secret/key", resolved?.rules ?? []).effect).toBe("deny")
    expect(PermissionV2.evaluate("bash", "pwd", resolved?.rules ?? []).effect).toBe("ask")
    }),
  )

  it.effect("does not let nested invoking rules broaden a selected profile", () =>
    Effect.sync(() => {
      const parent = profile({
        name: "parent",
        version: "1",
        rules: [{ action: "edit", resource: "secret/*", effect: "deny" }],
      })
      const nested = PermissionV2.mergeNarrowing(parent.rules, [{ action: "edit", resource: "*", effect: "allow" }])

      expect(PermissionV2.evaluate("edit", "secret/key", nested).effect).toBe("deny")
    }),
  )

  it.effect("does not let plugin-like wildcard rules broaden a parent profile deny", () =>
    Effect.sync(() => {
      const parent = profile({
        name: "parent",
        version: "1",
        rules: [{ action: "bash", resource: "git push *", effect: "deny" }],
      })
      const pluginRules: PermissionV2.Ruleset = [
        { action: "*", resource: "*", effect: "allow" },
        { action: "bash", resource: "*", effect: "allow" },
      ]
      const narrowed = PermissionV2.mergeNarrowing(parent.rules, pluginRules)

      expect(PermissionV2.evaluate("bash", "git push origin main", narrowed).effect).toBe("deny")
    }),
  )

  it.effect("does not let an expiring grant override a later configured deny", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const input = assertion({ action: "bash", resources: ["git push origin main"] })
      const { fiber, request } = yield* waitForRequest(input)
      yield* service.reply({ requestID: request.id, reply: "session", expiresAt: Date.now() + 60_000 })
      yield* Fiber.join(fiber)
      expect(yield* service.ask(input)).toMatchObject({ effect: "allow" })

      yield* setRules([{ action: "bash", resource: "git push *", effect: "deny" }])
      expect(yield* service.ask(input)).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("does not let plugin-like agent rules broaden a resolved parent profile deny", () =>
    Effect.gen(function* () {
      yield* setup()
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("test"), (agent) => {
          const resolved = PermissionV2.resolveProfile("child", [
            profile({
              name: "parent",
              version: "1",
              rules: [{ action: "bash", resource: "git push *", effect: "deny" }],
            }),
            profile({
              name: "child",
              version: "1",
              parent: "parent",
              rules: [{ action: "bash", resource: "*", effect: "allow" }],
            }),
          ])
          agent.permissionProfile = resolved && { ...resolved, rules: resolved.rules.map((rule) => ({ ...rule })) }
          agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
        }),
      )
      const service = yield* PermissionV2.Service

      expect(
        yield* service.ask(assertion({ action: "bash", resources: ["git push origin main"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toMatchObject({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toMatchObject({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toMatchObject({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(PermissionV2.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toMatchObject({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toMatchObject({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toMatchObject({ id: PermissionV2.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toMatchObject({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toMatchObject({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toMatchObject({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("expires once, session, and project scoped grants", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const expired = Date.now() - 1
      for (const scope of ["once", "session", "project"] as const) {
        const active = assertion({ id: PermissionV2.ID.create(`per_active_${scope}`), resources: [`active-${scope}`] })
        const { fiber, request } = yield* waitForRequest(active)
        yield* service.reply({ requestID: request.id, reply: scope, idempotencyKey: `active-${scope}` })
        yield* Fiber.join(fiber)
        expect(yield* service.ask(active)).toMatchObject({ effect: "allow" })
        const expiredInput = assertion({ id: PermissionV2.ID.create(`per_expired_${scope}`), resources: [`expired-${scope}`] })
        const { fiber: expiredFiber, request: expiredRequest } = yield* waitForRequest(expiredInput)
        yield* service.reply({
          requestID: expiredRequest.id,
          reply: scope,
          expiresAt: expired,
          idempotencyKey: `expired-${scope}`,
        })
        yield* Fiber.join(expiredFiber)
        const result = yield* service.ask(expiredInput)
        expect(result).toMatchObject({ effect: "ask" })
        if (result.effect === "ask") yield* service.reply({ requestID: result.id, reply: "reject" })
      }
    }),
  )

  it.effect("records immutable decision audit metadata and deduplicates approval replies", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(request.decision).toMatchObject({
        requestedAction: "read",
        requestedResources: ["src/index.ts"],
        agent: "test",
        approvalSource: "policy",
      })
      yield* Effect.all(
        [
          service.reply({ requestID: request.id, reply: "session", idempotencyKey: "approval-1" }),
          service.reply({ requestID: request.id, reply: "session", idempotencyKey: "approval-1" }),
        ],
        { concurrency: "unbounded" },
      )
      yield* Fiber.join(fiber)
    }),
  )

  it.effect("publishes a finalized grant audit without changing pending permission authority", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      const events = yield* EventV2.Service
      const finalized = yield* Deferred.make<Record<string, unknown>>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Replied.type
          ? Deferred.succeed(finalized, event.data as Record<string, unknown>).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* service.reply({
        requestID: request.id,
        reply: "session",
        expiresAt: 4_000,
        idempotencyKey: "audit-grant",
      })
      expect(yield* Deferred.await(finalized)).toMatchObject({
        requestID: request.id,
        reply: "session",
        workspaceDirectory: "/project",
        projectID: Project.ID.global,
        decision: expect.objectContaining({ requestedAction: "read", approvalSource: "user" }),
        grant: {
          scope: "session",
          action: "read",
          resources: ["src/index.ts"],
          sessionID: "ses_test",
          expiresAt: 4_000,
          idempotencyKey: "audit-grant",
        },
      })
      expect(yield* service.list()).toEqual([])
      yield* Fiber.join(fiber)
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )
})
