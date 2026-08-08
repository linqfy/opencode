import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionDiagnostics } from "@opencode-ai/core/capability/diagnostics"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, SessionDiagnostics.node])),
)

describe("cacheHitRate", () => {
  test("cache hits dominate the served share of fresh input", () => {
    expect(SessionDiagnostics.cacheHitRate({ input: 1_000, cacheRead: 9_000 })).toBeCloseTo(0.9)
    expect(SessionDiagnostics.cacheHitRate({ input: 1_000, cacheRead: 0 })).toBe(0)
    expect(SessionDiagnostics.cacheHitRate({ input: 0, cacheRead: 0 })).toBe(0)
  })
})

describe("SessionDiagnostics", () => {
  it.effect("records a step row and pages over it by cursor", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionV2.ID.make("ses_diag"),
          project_id: ProjectV2.ID.global,
          slug: "diag",
          directory: "/project",
          title: "diag",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const diagnostics = yield* SessionDiagnostics.Service
      const usage = { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 50 } }
      yield* diagnostics.record({
        sessionID: "ses_diag",
        assistantMessageID: "msg_1",
        providerID: "openai",
        modelID: "gpt-4o-mini",
        profileID: "openai-chat:openai/gpt-4o-mini",
        usage,
      })
      yield* diagnostics.record({
        sessionID: "ses_diag",
        assistantMessageID: "msg_2",
        providerID: "openai",
        modelID: "gpt-4o-mini",
        profileID: "openai-chat:openai/gpt-4o-mini",
        usage,
      })
      const first = yield* diagnostics.listStepUsage({ sessionID: "ses_diag", limit: 1 })
      expect(first.rows).toHaveLength(1)
      expect(first.rows[0]?.cacheHitRate).toBeCloseTo(0.9)
      expect(first.nextCursor).toBe(first.rows[0]?.id ?? null)
      const second = yield* diagnostics.listStepUsage({ sessionID: "ses_diag", cursor: first.nextCursor ?? undefined })
      expect(second.rows).toHaveLength(1)
      expect(second.nextCursor).toBeNull()
    }),
  )

  it.effect("a failed diagnostics write does not fail the step run", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const diagnostics = yield* SessionDiagnostics.Service
      // ses_diag_missing has no SessionTable row, so the FK insert fails.
      yield* diagnostics.record({
        sessionID: "ses_diag_missing",
        assistantMessageID: "msg_1",
        providerID: "openai",
        modelID: "gpt-4o-mini",
        profileID: "openai-chat:openai/gpt-4o-mini",
        usage: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 50 } },
      })
    }),
  )
})
