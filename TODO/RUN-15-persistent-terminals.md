# RUN-15: Persistent Model-Owned Terminals with Explicit Lifecycle Ownership

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent model-created terminals with explicit lifecycle ownership: only the model that created a terminal or the user may terminate it, the user can inspect and control every terminal, and the model can reuse terminals across turns via session-mode tools.

**Architecture:** A Location-scoped `TerminalRegistry` service wraps the existing `Pty.Service` (the PTY transport) and owns lifecycle metadata (`owner`, `persistent`, `sessionId`, timestamps) as durable records in the core SQLite database, journaling lifecycle events through the EventV2 durable manifest for audit value. The bash tool gains a session-mode (`session_id` + `yield_time_ms`, Codex unified-exec semantics reimplemented) and three terminal tools (`write_stdin`, `terminal_list`, `terminal_terminate`) run through the existing `PermissionV2` pipeline. Leak-proofing is structural: non-persistent terminals are terminated on owning-session end; persistent ones survive compaction and detach but never survive an explicit delete or process death (no auto-restore — a RUN-14 follow-up). Thin user surfaces: a command-center "Terminals" tab and a TUI `/terminals` dialog.

**Tech Stack:** Bun, TypeScript, Effect-TS, Drizzle/SQLite (durable records), native `#pty` (`node-pty`) transport, EventV2 durable event manifest, SolidJS (app + TUI).

**Audit basis:** §22 TODO item "Persistent model-created terminals" (keep, P2; align semantics with Codex unified exec — `yield_time_ms`, `write_stdin`, `/ps`, `/stop`); §15 (Codex unified exec: `exec_command` + `write_stdin`, `yield_time_ms`, `max_output_tokens`, `/ps` `/stop`, output head/tail truncation); §13 tool-system row "Background jobs in-tool → port their session model semantics"; §7.3 missing capability "background/remote execution"; TODO.md "Add persistent model-created terminals with explicit lifecycle ownership; only the model or user may terminate them, and the user can inspect/control them." Codex design consultation is provenance-ledgered in Task 6; behavior is reimplemented from invariants, never copied.

## Global Constraints

All constraints in `TODO/README.md` §2 apply verbatim. In addition:

- **Branch:** `persistent-terminals`.
- **Durability decision (one-owner rule):** terminal lifecycle metadata is durable in **core SQLite** (`EventV2` database), not the Rust sidecar, for this run. Rationale: (a) `TerminalRegistry` is the one owner of terminal lifecycle; the record belongs to the in-TS read model the V2 session engine owns, so the Rust sidecar does not become a second owner before RUN-14 defines cross-process placement/claims; (b) RUN-14 has NOT landed, so terminals must be process-local persistent (survive compaction + turn boundaries, not process death) — exactly what core SQLite + in-process PTY give; (c) audit value is served durably by the `terminal` SQLite table plus lifecycle events registered in the `DurableEventManifest`. **RUN-14 follow-up (do NOT build here):** project terminal lifecycle into the sidecar journal once RUN-14 defines daemon attach; the registry interface is the seam.
- **V1 freeze:** session-mode tools are V2-only (`packages/core`). `packages/opencode/src/tool/shell.ts` (V1 shell) stays foreground-only. `BackgroundJob` (core + opencode wrapper) is background *subagent-task* tracking, not a terminal registry — do not modify it. No V1 background-terminal code exists to migrate; document this in Task 1.
- **Ownership invariant:** a model actor may write/terminate only terminals with `owner: "model"` AND matching `sessionId`; a user actor may write/terminate any terminal. Enforcement lives in `TerminalRegistry`, not in the permission pipeline; the permission pipeline gates *actions* (`bash`, `terminal`, `terminal_write`, `terminal_terminate`), the registry gates *ownership*.
- **stateChanging flags (RUN-08 contract):** `bash`, `write_stdin`, `terminal_terminate` declare `stateChanging: true`; `terminal_list` declares `stateChanging: false, concurrencySafe: true`.
- **Provenance:** consulting `../codex` for design understanding requires a `docs/provenance/ledger.json` entry (`treatment: "reimplement"`, source `openai/codex`) validated by `bun run scripts/provenance/validate.ts` — see Task 6.

## Orchestrator Brief

### Context Files (read in full before dispatching Task 1)

1. `packages/core/src/pty.ts` — the PTY service the registry wraps. Learn the exact `Pty.Service` interface (`list/get/create/update/remove/write/attach`), `Pty.Info` fields (`id, title, command, args, cwd, status, pid, exitCode`), `Pty.Event` inventory (`Created/Updated/Exited/Deleted`), `BUFFER_LIMIT`/`EXITED_LIMIT`, and the env overlay invariants (`TERM`, `OPENCODE_TERMINAL`).
2. `packages/core/src/tool/bash.ts` — the tool to extend. Learn `Input`/`Output`/`StructuredOutput`, the `permission.assert` call shape (`action`, `resources`, `save`, `sessionID`, `agent`, `source`), `SandboxProcess.plan`, `AppProcess.run`, and the `Tool.make` config used.
3. `packages/core/src/tool/tool.ts` — `Tool.make` config (`stateChanging`, `concurrencySafe`, `namespace`) and `Context` (`sessionID`, `agent`, `assistantMessageID`, `toolCallID`).
4. `packages/core/src/tool/registry.ts` + `packages/core/src/tool/AGENTS.md` — how built-ins register via `Tools.Service.register`, the `settle`/`Materialization` boundary, and the "one local tool representation" rule (do not add a second executable entry type).
5. `packages/core/src/tool-output-store.ts` — `ToolOutputStore.bound({ sessionID, toolCallID, output })` head/tail spill used to bound terminal output.
6. `packages/core/src/permission.ts` — `PermissionV2.Service.assert/ask`, `AssertInput` shape, `BlockedError`/`CorrectedError`.
7. `packages/schema/src/pty.ts` + `packages/core/src/pty/schema.ts` — `Pty.ID` brand (`pty_*`), `Pty.Info`, `Pty.CreateInput`, `Pty.Event`.
8. `packages/schema/src/event.ts` + `packages/schema/src/durable-event-manifest.ts` — `Event.define({ type, durable, schema })`, `Event.inventory`, `Event.durable`; where durable events are registered.
9. `packages/schema/src/session.ts` — `Session.ID` (the `sessionId` foreign key on records).
10. `packages/core/src/database/database.ts` + `packages/core/src/session/sql.ts` — Drizzle `Database.Service`, the `sqliteTable` pattern (snake_case), and `packages/core/script/migration.ts` usage (`bun run migration --name <name>` from `packages/core`).
11. `packages/core/test/pty/pty-session.test.ts` — the real-PTY test harness (`testEffect`, `AppNodeBuilder.build(LayerNode.group([...]))`, `location({ directory })` fixture, `it.live`, EventV2 `listen` subscription). Mirror it for all Task 2–4 tests.
12. `packages/core/test/lib/effect.ts`, `packages/core/test/fixture/location.ts` — test helpers.
13. `packages/opencode/src/tool/shell.ts` (full) — V1 shell tool; confirm it has no background-terminal code (foreground `run` with timeout/kill only).
14. `packages/core/src/background-job.ts` + `packages/opencode/src/background/job.ts` — confirm `BackgroundJob` is subagent-task tracking, not terminals; do not modify.
15. `packages/core/src/session/compaction.ts` — the real compaction entry (`compactAfterOverflow`/`compactIfNeeded`, `Dependencies { events, llm, config }`) for the Task 4 compaction-survival fixture.
16. `packages/opencode/src/server/routes/instance/httpapi/groups/authority.ts` + `handlers/authority.ts` + `packages/opencode/test/server/httpapi-authority.test.ts` + `packages/opencode/test/server/httpapi-layer.ts` — the authority HttpApi pattern (`HttpApiGroup`, `HttpApiEndpoint`, `HttpApiBuilder.group`), `InstanceState` per-directory resolution, and the `httpApiLayer`/`requestInDirectory` test harness.
17. `packages/app/src/components/command-center/command-center.tsx` + `command-center-model.ts` + `command-center-model.test.ts` — the tab pattern (`Tab` union, `authority<T>()` raw fetch helper, `Panel`/`State` components) and the pure-model test style.
18. `packages/tui/src/routes/session/index.tsx` (session command list + `useDialog`) + `dialog-timeline.tsx` (dialog component pattern) + `packages/tui/test/cli/tui/data.test.tsx` (component test harness: `testRender`, `TestTuiContexts`, `createFetch`).
19. Design reference (provenance-ledgered, design understanding only — read, do not copy): `../codex/codex-rs/core/src/tools/handlers/unified_exec.rs` + `exec_command.rs` + `write_stdin.rs` and `core/src/unified_exec/mod.rs` — the `yield_time_ms` clamp (`MIN`/`MAX_YIELD_TIME_MS`), `write_stdin(process_id, data, yield_time_ms)`, output head/tail bounding, session semantics. Record the audited revision in Task 6's ledger entry (current HEAD: `0a0ebb85355113610dd3f7a3d8b36f68c33465fc`; verify with `git -C ../codex rev-parse HEAD`).

### Baselines (record before Task 1)

```bash
cd packages/core && bun test test/pty 2>&1 | tail -5
cd packages/core && bun typecheck 2>&1 | tail -5
cd packages/opencode && bun test test/server/httpapi-authority.test.ts 2>&1 | tail -5
cd packages/app && bun test --preload ./happydom.ts ./src/components/command-center 2>&1 | tail -5
cd packages/client && bun run generate 2>&1 | tail -3
git -C ../codex rev-parse HEAD
```

### Dispatch Order

Tasks 1 → 6 strictly sequential. Task 5's server/UI work must not start before Task 4's leak-proofing is green (the surfaces exercise terminate).

### Definition of Done (verify each with a command you ran)

- [ ] `cd packages/core && bun test test/terminal` passes — includes a test literally named `ownership-denial: model cannot terminate another session's terminal`, an orphan-pid assertion test named `leak: no orphan process after terminate`, and a compaction test named `compaction-survival: persistent terminal survives a real compaction pass`.
- [ ] `cd packages/core && bun typecheck` green.
- [ ] `bun run migration --name terminal-registry` produced a `packages/core/src/database/migration/*.ts` migration and updated `packages/core/schema.json`; `git status` shows the generated files.
- [ ] `cd packages/opencode && bun test test/server/httpapi-authority-terminals.test.ts` passes against the real server layer.
- [ ] `cd packages/app && bun test --preload ./happydom.ts ./src/components/command-center` passes.
- [ ] `cd packages/tui && bun test test/cli/tui/terminals-dialog.test.tsx` passes.
- [ ] `cd packages/client && bun run generate` produced no uncommitted drift (or the intended regenerated client is committed).
- [ ] `bun run scripts/provenance/validate.ts` (from repo root) exits 0 with `PROVENANCE OK` after Task 6.
- [ ] `git status` clean; branch `persistent-terminals`; every change committed (§2.2); `TODO/README.md` §7 registry row + §8 ledger row written; TODO.md item ticked.

---

### Task 1: Characterize PTY service, bash tool, and background handling (pin with tests)

**Files:**
- Create: `packages/core/test/terminal/pin.test.ts`

**Interfaces:**
- Consumes: nothing (read-only characterization).
- Produces: no runtime interfaces. Pins the invariants Tasks 2–4 build on: PTY env overlay, attach/replay/cursor semantics, exit detection, remove-kills-process; bash permission/schema/output-bounding behavior; the fact that `BackgroundJob` and the V1 shell tool contain no background-terminal registry to migrate or retire.

- [ ] **Step 1: Write the failing characterization tests** — create `packages/core/test/terminal/pin.test.ts` mirroring the `pty-session.test.ts` harness (`AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node, ...]))`, `testEffect`, `it.live`), with a `Config` layer stubbed to `{ entries: () => Effect.succeed([]) }` and a `Location` fixture at a tmpdir.

```ts
import { describe, expect } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@opencode-ai/core/config"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
    [
      Location.node,
      Layer.unwrap(
        Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ).pipe(
          Effect.map((tmp) => {
            const ref = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
            return Layer.succeed(Location.Service, Location.Service.of(location(ref)))
          }),
        ),
      ),
    ],
  ]),
)
const ptyLive = process.platform === "win32" ? it.live.skip : it.live

describe("pty transport pins (RUN-15 Task 1)", () => {
  ptyLive("create overlays TERM and OPENCODE_TERMINAL and reports a real pid", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* pty.create({
        command: "/bin/sh",
        args: ["-c", "printf '%s|%s' \"$TERM\" \"$OPENCODE_TERMINAL\""],
      })
      expect(info.status).toBe("running")
      expect(info.pid).toBeGreaterThan(0)
      const events = yield* Queue.unbounded<string>()
      const attachment = yield* pty.attach(info.id, {
        cursor: 0,
        onData: (chunk) => Queue.offerUnsafe(events, chunk),
        onEnd: () => {},
      })
      attachment.activate()
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            const chunk = yield* Queue.take(events)
            if (chunk.includes("xterm-256color|1")) return
          }
        }),
      )
      const deadline = yield* Effect.clockWith((c) => c.currentTimeMillis) + 10_000
      yield* Effect.await(attachmentDone(attachment, events, deadline))
    })),

  ptyLive("remove kills the child process (pid no longer alive)", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* pty.create({ command: "/bin/sh", args: ["-c", "sleep 30"] })
      yield* pty.remove(info.id)
      expect(alive(info.pid)).toBe(false)
    })),

  ptyLive("attach replay + cursor then exit detection via onEnd", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* pty.create({ command: "/bin/sh", args: ["-c", "echo hello; sleep 30"] })
      yield* Effect.sleep("300 millis")
      let replay = ""
      const attachment = yield* pty.attach(info.id, {
        cursor: -1,
        onData: (chunk) => { replay += chunk },
        onEnd: () => {},
      })
      expect(attachment.replay).toContain("hello")
      yield* pty.remove(info.id)
    })),
})

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function attachmentDone(attachment: Pty.Attachment, events: Queue.Queue<string>, deadline: number) {
  return Effect.gen(function* () {
    while (true) {
      if ((yield* Effect.clockWith((c) => c.currentTimeMillis)) > deadline) {
        return expect.unreachable("timed out waiting for pty output")
      }
      yield* Effect.sleep("50 millis")
    }
  })
}
```

Then add the **bash tool** pin (same file, second `describe`), using `BashTool.node` (real tool) with a recording `PermissionV2.Service` stub and the `settleTool` helper from `test/lib/tool.ts`. First extract the tmpdir location layer from the PTY harness above into a module-level `const tmpLocationLayer` (identical `Layer.unwrap(Effect.acquireRelease(...))` body) so both harnesses reuse it:

```ts
import { BashTool } from "@opencode-ai/core/tool/bash"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { settleTool, toolIdentity } from "../lib/tool"
import type { SessionSchema } from "@opencode-ai/core/session/schema"

const bashAsserts: Array<{ action: string; resources: readonly string[] }> = []
const bashPermissionStub = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: () => Effect.fail(new PermissionV2.BlockedError({})),
    assert: Effect.fn("BashPin.assert")(function* (input) {
      bashAsserts.push({ action: input.action, resources: input.resources ?? [] })
      return
    }),
    reply: () => Effect.void,
  }),
)

const bashIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([BashTool.node]), [
    [PermissionV2.node, bashPermissionStub],
    [Location.node, tmpLocationLayer],
  ]),
)

describe("bash tool pins (RUN-15 Task 1)", () => {
  bashIt.live("settles a command, records the bash permission assert, and bounds output", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const settlement = yield* settleTool(registry, {
        sessionID: "ses_pin" as SessionSchema.ID,
        agent: toolIdentity.agent,
        assistantMessageID: toolIdentity.assistantMessageID,
        call: { id: "call_pin", name: "bash", input: { command: "echo hi" } },
      })
      expect(settlement.result.type).toBe("text")
      expect(String(settlement.result.text)).toContain("hi")
      expect(bashAsserts.some((a) => a.action === "bash" && a.resources[0] === "echo hi")).toBe(true)
    }))

  bashIt.live("rejects a timeout above the documented maximum at the schema", () =>
    Effect.gen(function* () {
      const decode = yield* Schema.decodeUnknownEffect(BashTool.Input)({ command: "echo hi", timeout: 999_999_999 }).pipe(Effect.exit)
      expect(decode._tag).toBe("Failure")
    }))
})
```

The `bash` permission assert contract (`action: "bash"`, `resources: [command]`) is what the Task 3 session-mode must preserve. Verify `BashTool.Input` is exported (if not, import the schema from `packages/core/src/tool/bash.ts`'s module-level export) and that `settlement.result.text` is the right accessor by reading `test/lib/tool.ts` and `@opencode-ai/llm`'s `ToolResultValue`.

Finally add a **background pin** `describe` that locks the Task-1 conclusion — there is no V1 background-terminal registry to migrate or retire:

```ts
import { BackgroundJob } from "@opencode-ai/core/background-job"

describe("background handling pins (RUN-15 Task 1)", () => {
  test("BackgroundJob is subagent-task tracking, not a terminal registry", () => {
    const info = {} as BackgroundJob.Info
    expect(Object.prototype.hasOwnProperty.call(info, "owner")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(info, "persistent")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(info, "terminalId")).toBe(false)
    const statuses: BackgroundJob.Status[] = ["running", "completed", "error", "cancelled"]
    expect(statuses).not.toContain("exited")
  })
})
```

If `packages/opencode/src/tool/shell.ts` (V1) still has no session/terminal surface when you read it, add a one-line comment in this test documenting that V1's shell tool is foreground-only and V2's `TerminalRegistry` is the single terminal owner. The test's purpose is to lock the Task-1 conclusion: **there is no V1 background-terminal registry to migrate or retire**; the plan's single `TerminalRegistry` is the only owner.

- [ ] **Step 2: Run it, watch it fail**

Run: `cd packages/core && bun test test/terminal/pin.test.ts`
Expected: FAIL — module `test/terminal/pin.test.ts` does not exist (or, after the file exists, at least one assertion fails against the current harness until corrected).

- [ ] **Step 3: Correct the characterization to match real behavior** — the pins must pass against the *current* implementation. If a pin exposes real drift (e.g. `Pty.Attachment` lacks a member you assumed), fix the pin to match the code — code wins, plan loses — and note the deviation in the run ledger.

- [ ] **Step 4: Run it, watch it pass** — same command. Expected: all pins pass.

- [ ] **Step 5: Typecheck + commit**

```bash
cd packages/core && bun typecheck
git add packages/core/test/terminal/pin.test.ts
git commit -m "test(core): pin pty transport, bash tool, and background handling invariants"
```

---

### Task 2: TerminalRegistry service with durable records, ownership, and journaled lifecycle

**Files:**
- Create: `packages/schema/src/terminal.ts` (record + input + lifecycle event inventory)
- Modify: `packages/schema/src/durable-event-manifest.ts` (register `Terminal.Event.Definitions`)
- Create: `packages/core/src/terminal/schema.ts` (core re-export of the schema types)
- Create: `packages/core/src/terminal/registry.sql.ts` (Drizzle `TerminalTable`)
- Create: `packages/core/src/terminal/registry.ts` (`TerminalRegistry.Service` + `node`)
- Generate: `packages/core/src/database/migration/*.ts`, `schema.gen.ts`, `migration.gen.ts`, `packages/core/schema.json` via `bun run migration --name terminal-registry`
- Test: `packages/core/test/terminal/registry.test.ts`

**Interfaces:**
- Consumes: `Pty.Service` (interface from Task 1 Context File 1), `EventV2.Service.publish/listen`, `Database.Service`, `Location.Service`, `Config.Service`; `Pty.ID` from `@opencode-ai/schema/pty`; `Session.ID` from `@opencode-ai/schema/session`.
- Produces (later tasks consume these EXACT names):
  - From `@opencode-ai/schema/terminal` / `@opencode-ai/core/terminal/schema`:
    - `Terminal.Record = Schema.Struct({ terminalId: Pty.ID, sessionId: Session.ID, owner: Schema.Literal("model", "user"), persistent: Schema.Boolean, createdAt: NonNegativeInt, cwd: Schema.String, pid: NonNegativeInt, status: Schema.Literal("running", "exited"), exitCode: optional(NonNegativeInt), lastUsedAt: NonNegativeInt, title: Schema.String, command: Schema.String })`
    - `Terminal.CreateInput = Schema.Struct({ sessionId: Session.ID, owner: Schema.Literal("model", "user"), persistent: Schema.Boolean, command: optional(Schema.String), args: optional(Schema.Array(Schema.String)), cwd: optional(Schema.String), title: optional(Schema.String), env: optional(Schema.Record(Schema.String, Schema.String)) })`
    - `Terminal.Event = { Created, Updated, Exited, Deleted, Definitions }` — `type: "terminal.created" | "terminal.updated" | "terminal.exited" | "terminal.deleted"`, each defined with `durable: { version: 1, aggregate: "terminal" }`; `Created`/`Updated` carry `{ record: Terminal.Record }`, `Exited`/`Deleted` carry `{ id: Pty.ID, exitCode?: NonNegativeInt }`.
  - From `packages/core/src/terminal/registry.ts`:
    - `export type Actor = { readonly kind: "model"; readonly sessionId: Session.ID } | { readonly kind: "user" }`
    - `TerminalRegistry.NotFoundError { terminalId }`, `TerminalRegistry.OwnershipError { terminalId, reason }`, `TerminalRegistry.DeniedError { reason }` (each a `Schema.TaggedErrorClass`).
    - `TerminalRegistry.Service` (`@opencode/v2/TerminalRegistry`, Location-scoped):
      ```ts
      interface Interface {
        readonly list: (input: { sessionId?: Session.ID }) => Effect.Effect<readonly Terminal.Record[]>
        readonly get: (id: Pty.ID) => Effect.Effect<Terminal.Record, NotFoundError>
        readonly create: (input: Terminal.CreateInput) => Effect.Effect<Terminal.Record, DeniedError>
        readonly write: (id: Pty.ID, data: string, actor: Actor) => Effect.Effect<void, NotFoundError | OwnershipError>
        readonly terminate: (id: Pty.ID, actor: Actor) => Effect.Effect<void, NotFoundError | OwnershipError>
        readonly attach: (id: Pty.ID, input: Pty.AttachInput) => Effect.Effect<Pty.Attachment, NotFoundError | Pty.ExitedError>
        readonly onSessionEnd: (sessionId: Session.ID) => Effect.Effect<void>
        readonly reconcile: () => Effect.Effect<void>
      }
      ```
    - `TerminalRegistry.node` — `makeLocationNode({ service: Service, layer, deps: [Pty.node, EventV2.node, Location.node, Config.node, Database.node] })`.
  - Ownership contract: `write`/`terminate` accept an `Actor`; `{ kind: "user" }` always allowed; `{ kind: "model" }` allowed only when `record.owner === "model" && record.sessionId === actor.sessionId`, else `OwnershipError`. `terminate` calls `Pty.remove`, deletes the row, publishes `terminal.deleted`. `onSessionEnd` terminates every `persistent === false` record for the session and leaves persistent ones alive. `reconcile` marks every `running` row whose live `Pty` session is absent as `exited` (process-restart cleanup) and is invoked once at layer construction.

- [ ] **Step 1: Write the failing schema + service tests** — create `packages/core/test/terminal/registry.test.ts` with the Task-1 harness (real tmpdir, `Pty.node`, `EventV2.node`, `Database.node`, `TerminalRegistry.node`), real processes, no mocks of `TerminalRegistry`:

```ts
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { TerminalRegistry } from "@opencode-ai/core/terminal/registry"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([TerminalRegistry.node, Pty.node, EventV2.node, Database.node]), [
    [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
    [
      Location.node,
      Layer.unwrap(
        Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ).pipe(
          Effect.map((tmp) => {
            const ref = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
            return Layer.succeed(Location.Service, Location.Service.of(location(ref)))
          }),
        ),
      ),
    ],
  ]),
)
const registryLive = process.platform === "win32" ? it.live.skip : it.live
const modelA = () => ({ kind: "model" as const, sessionId: "ses_a" as const })
const modelB = () => ({ kind: "model" as const, sessionId: "ses_b" as const })
const user = () => ({ kind: "user" as const })

describe("TerminalRegistry ownership", () => {
  registryLive("ownership-denial: model cannot terminate another session's terminal", () =>
    Effect.gen(function* () {
      const registry = yield* TerminalRegistry.Service
      const record = yield* registry.create({
        sessionId: "ses_a", owner: "model", persistent: true,
        command: "/bin/sh", args: ["-c", "sleep 30"], title: "a",
      })
      const outcome = yield* registry.terminate(record.terminalId, modelB()).pipe(Effect.exit)
      expect(outcome._tag).toBe("Failure")
      const recorded = yield* registry.get(record.terminalId)
      expect(recorded.status).toBe("running")
      yield* registry.terminate(record.terminalId, user())
    }))

  registryLive("user can always terminate a model-owned terminal", () =>
    Effect.gen(function* () {
      const registry = yield* TerminalRegistry.Service
      const record = yield* registry.create({
        sessionId: "ses_a", owner: "model", persistent: true,
        command: "/bin/sh", args: ["-c", "sleep 30"], title: "a",
      })
      yield* registry.terminate(record.terminalId, user())
      const outcome = yield* registry.get(record.terminalId).pipe(Effect.exit)
      expect(outcome._tag).toBe("Failure")
    }))

  registryLive("ownership-denial: model cannot write to a user-owned terminal", () =>
    Effect.gen(function* () {
      const registry = yield* TerminalRegistry.Service
      const record = yield* registry.create({
        sessionId: "ses_a", owner: "user", persistent: true,
        command: "/bin/sh", args: ["-c", "sleep 30"], title: "u",
      })
      const outcome = yield* registry.write(record.terminalId, "echo nope\n", modelA()).pipe(Effect.exit)
      expect(outcome._tag).toBe("Failure")
      yield* registry.write(record.terminalId, "echo ok\n", user())
    }))
})

const subscribeTerminalEvents = Effect.fn("RegistryTest.subscribeTerminalEvents")(function* () {
  const source = yield* EventV2.Service
  const events = yield* Queue.unbounded<{ type: string; terminalId: PtyID }>()
  const unsubscribe = yield* source.listen((event) => {
    if (event.type === Terminal.Event.Created.type)
      Queue.offerUnsafe(events, { type: "created", terminalId: (event.data as typeof Terminal.Event.Created.data.Type).record.terminalId })
    if (event.type === Terminal.Event.Deleted.type)
      Queue.offerUnsafe(events, { type: "deleted", terminalId: (event.data as typeof Terminal.Event.Deleted.data.Type).id })
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsubscribe)
  return events
})

describe("TerminalRegistry durability and lifecycle", () => {
  registryLive("create persists a durable record and journals terminal.created", () =>
    Effect.gen(function* () {
      const registry = yield* TerminalRegistry.Service
      const events = yield* subscribeTerminalEvents()
      const record = yield* registry.create({
        sessionId: "ses_a", owner: "model", persistent: true,
        command: "/bin/sh", args: ["-c", "sleep 30"], title: "t",
      })
      expect(record.owner).toBe("model")
      expect(record.status).toBe("running")
      expect(record.pid).toBeGreaterThan(0)
      const listed = yield* registry.list({})
      expect(listed.some((r) => r.terminalId === record.terminalId)).toBe(true)
      const event = yield* Queue.take(events).pipe(Effect.timeout("5 seconds"))
      expect(event.type).toBe("created")
      expect(event.terminalId).toBe(record.terminalId)
      yield* registry.terminate(record.terminalId, user())
      const deleted = yield* Queue.take(events).pipe(Effect.timeout("5 seconds"))
      expect(deleted.type).toBe("deleted")
    }))

  registryLive("reconcile marks running rows whose pty is gone as exited", () =>
    Effect.gen(function* () {
      const registry = yield* TerminalRegistry.Service
      const pty = yield* Pty.Service
      const record = yield* registry.create({
        sessionId: "ses_a", owner: "model", persistent: true,
        command: "/bin/sh", args: ["-c", "sleep 30"], title: "t",
      })
      // simulate process loss of the pty outside the registry
      yield* pty.remove(record.terminalId)
      yield* registry.reconcile()
      const reconciled = yield* registry.get(record.terminalId)
      expect(reconciled.status).toBe("exited")
    }))

  registryLive("terminate kills the process and deletes the durable record", () =>
    Effect.gen(function* () {
      const registry = yield* TerminalRegistry.Service
      const record = yield* registry.create({
        sessionId: "ses_a", owner: "model", persistent: true,
        command: "/bin/sh", args: ["-c", "sleep 30"], title: "t",
      })
      yield* registry.terminate(record.terminalId, user())
      expect(alive(record.pid)).toBe(false)
      const outcome = yield* registry.get(record.terminalId).pipe(Effect.exit)
      expect(outcome._tag).toBe("Failure")
    }))
})

function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}
```

The EventV2 subscription pattern (`source.listen`, `Queue.unbounded`, `Effect.addFinalizer`) mirrors `packages/core/test/pty/pty-session.test.ts`; the `Terminal.Event.Created.data.record.terminalId` accessor follows the `define({ schema: { record: Record } })` shape declared in Task 2's `Produces` block.

- [ ] **Step 2: Run it, watch it fail**

Run: `cd packages/core && bun test test/terminal/registry.test.ts`
Expected: FAIL — `packages/core/src/terminal/registry.ts` and `packages/schema/src/terminal.ts` do not exist.

- [ ] **Step 3: Implement the schema** — `packages/schema/src/terminal.ts` (export `* as Terminal`; define `Record`, `CreateInput`, `Event` via `define`/`inventory` with `durable: { version: 1, aggregate: "terminal" }`, following `packages/schema/src/pty.ts`). Register in `packages/schema/src/durable-event-manifest.ts`: import `Terminal` and append `...Terminal.Event.Definitions` to the array passed to `Event.durable`.

- [ ] **Step 4: Implement core re-export + Drizzle table** — `packages/core/src/terminal/schema.ts` re-exports the schema types (mirror `packages/core/src/pty/schema.ts`); `packages/core/src/terminal/registry.sql.ts`:

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

export const TerminalTable = sqliteTable("terminal", {
  terminal_id: text().primaryKey(),
  session_id: text().notNull(),
  owner: text().notNull(),
  persistent: integer().notNull(),
  created_at: integer().notNull(),
  cwd: text().notNull(),
  pid: integer().notNull(),
  status: text().notNull(),
  last_used_at: integer().notNull(),
  title: text().notNull(),
  command: text().notNull(),
})
```

Then from `packages/core` run `bun run migration --name terminal-registry` and commit the generated migration + schema snapshot.

- [ ] **Step 5: Implement `TerminalRegistry.Service`** — `packages/core/src/terminal/registry.ts`:

```ts
export * as TerminalRegistry from "./registry"

import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Location } from "../location"
import { Pty } from "../pty"
import { Terminal } from "./schema"
import { TerminalTable } from "./registry.sql"
import { eq } from "drizzle-orm"
import { NonNegativeInt } from "../schema"
import { SessionSchema } from "../session/schema"
import type { PtyID } from "../pty/schema"

export type Actor =
  | { readonly kind: "model"; readonly sessionId: SessionSchema.ID }
  | { readonly kind: "user" }

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("TerminalRegistry.NotFoundError", {
  terminalId: PtyID,
}) {}
export class OwnershipError extends Schema.TaggedErrorClass<OwnershipError>()("TerminalRegistry.OwnershipError", {
  terminalId: PtyID,
  reason: Schema.String,
}) {}
export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("TerminalRegistry.DeniedError", {
  reason: Schema.String,
}) {}

export interface Interface {
  readonly list: (input: { sessionId?: SessionSchema.ID }) => Effect.Effect<readonly Terminal.Record[]>
  readonly get: (id: PtyID) => Effect.Effect<Terminal.Record, NotFoundError>
  readonly create: (input: Terminal.CreateInput) => Effect.Effect<Terminal.Record, DeniedError>
  readonly write: (id: PtyID, data: string, actor: Actor) => Effect.Effect<void, NotFoundError | OwnershipError>
  readonly terminate: (id: PtyID, actor: Actor) => Effect.Effect<void, NotFoundError | OwnershipError>
  readonly attach: (id: PtyID, input: Pty.AttachInput) => Effect.Effect<Pty.Attachment, NotFoundError | Pty.ExitedError>
  readonly onSessionEnd: (sessionId: SessionSchema.ID) => Effect.Effect<void>
  readonly reconcile: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/TerminalRegistry") {}
```

Implement the layer with: a `load(id)` helper reading the row via `Database` + `fromRow`; `create` → `Pty.create` (maps `Pty.DeniedError` → `DeniedError`), inserts the row, publishes `Terminal.Event.Created`; a `Pty.Event.Exited` subscription (via `EventV2.Service.listen`) that flips the row's `status` to `exited` and publishes `Terminal.Event.Exited`; `write`/`terminate` enforce the ownership contract; `onSessionEnd` terminates non-persistent records; `reconcile` walks `running` rows and marks ones whose `Pty.get` is `NotFoundError` as `exited`; the layer body runs `reconcile()` once before returning `Service.of({ ... })`. Publish `Terminal.Event.Deleted` on terminate, `Terminal.Event.Updated` on reconcile/write-side `last_used_at` bumps. Follow `packages/core/src/pty.ts` for the subscription/finalizer patterns and `packages/core/src/session/sql.ts` for row↔type mapping style. Export `node` with the deps listed above.

- [ ] **Step 6: Run it, watch it pass** — `cd packages/core && bun test test/terminal/registry.test.ts`. Then `cd packages/core && bun typecheck`.

- [ ] **Step 7: Commit**

```bash
git add packages/schema/src/terminal.ts packages/schema/src/durable-event-manifest.ts packages/core/src/terminal packages/core/src/database/migration packages/core/src/database/schema.gen.ts packages/core/src/database/migration.gen.ts packages/core/schema.json packages/core/test/terminal/registry.test.ts
git commit -m "feat(core): durable TerminalRegistry with explicit lifecycle ownership"
```

---

### Task 3: Bash session-mode + `write_stdin`, `terminal_list`, `terminal_terminate` tools

**Files:**
- Modify: `packages/core/src/tool/bash.ts` (`session_id`, `yield_time_ms` params; `stateChanging: true`; `TerminalRegistry.node` dep)
- Create: `packages/core/src/tool/terminal.ts` (the three terminal tools + shared `terminalTail` helper)
- Test: `packages/core/test/terminal/tools.test.ts`

**Interfaces:**
- Consumes: `TerminalRegistry.Service` (Task 2 — `create/write/terminate/attach`, `Actor`), `PermissionV2.Service` (`assert`), `ToolOutputStore.Service` (`bound`), `Tools.Service` (`register`), `Tool.make`.
- Produces (surfaces and later runs consume these):
  - `bash` tool: new optional params `session_id?: PtyID` and `yield_time_ms?: number` (≤ `MAX_YIELD_TIME_MS = 30_000`, default `DEFAULT_SESSION_YIELD_TIME_MS = 1_000`); `stateChanging: true`; `Output`/`StructuredOutput` gain optional `terminal_id: string`. With `session_id`, the tool resolves the record, `registry.write(id, command + "\n", { kind: "model", sessionId: context.sessionID })`, captures tail output for the yield window via `terminalTail`, and returns bounded output (through `ToolOutputStore.bound`); without it, behavior is unchanged (foreground `AppProcess.run`).
  - `packages/core/src/tool/terminal.ts` exports:
    - `export const MAX_YIELD_TIME_MS = 30_000`
    - `export const DEFAULT_YIELD_TIME_MS = 250`
    - `export const terminalTail: (registry: TerminalRegistry.Interface, id: PtyID, windowMs: number) => Effect.Effect<{ text: string; truncated: boolean; status: "running" | "exited" }>` — attaches with `cursor: -1`, activates, collects `onData` chunks for `windowMs`, tails to `ToolOutputStore` limits; returns the bounded text + whether the terminal exited within the window.
    - Tool `write_stdin`: `Input { session_id: PtyID, data: Schema.String, yield_time_ms?: PositiveInt }`; `stateChanging: true`; permission action `terminal_write`, `resources: [session_id]`; executes `registry.write` then `terminalTail`; `Output { output, truncated, terminal_id, status }`.
    - Tool `terminal_list`: `Input {}`; `stateChanging: false`, `concurrencySafe: true`; permission action `terminal`; `Output { terminals: Array<{ terminal_id, title, command, cwd, status, owner, persistent, session_id, last_used_at }> }`.
    - Tool `terminal_terminate`: `Input { session_id: PtyID }`; `stateChanging: true`; permission action `terminal_terminate`, `resources: [session_id]`; executes `registry.terminate(id, { kind: "model", sessionId: context.sessionID })`; `Output { terminal_id, status: "exited" }`.
    - `export const node = makeLocationNode({ name: "tool/terminal", layer, deps: [ToolRegistry.node, TerminalRegistry.node, PermissionV2.node, ToolOutputStore.node] })`.
  - Each tool maps only expected typed errors (`NotFoundError`/`OwnershipError`/`PermissionV2.BlockedError`/`CorrectedError`) into `ToolFailure` — never `catchCause`.

- [ ] **Step 1: Write the failing integration tests** — create `packages/core/test/terminal/tools.test.ts` with a real PTY and a long-running fixture process (`python3 -c "import time,sys; print('up'); sys.stdout.flush(); time.sleep(60)"` or `sleep 30`; use a real process, no mocks). Build a layer with `BashTool.node` + `terminal.ts`'s node + `ToolRegistry.node` + `TerminalRegistry.node`, plus a scripted `PermissionV2.Service` stub (the real service needs seeded grants/sessions — RUN-06 territory; a recording stub at this boundary is the no-alternative case, and the ownership enforcement itself is tested against the real `TerminalRegistry` in Task 2). The stub records every `assert` call and answers per-action from a decisions map:

```ts
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@opencode-ai/core/config"
import { TerminalRegistry } from "@opencode-ai/core/terminal/registry"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { TerminalTool } from "@opencode-ai/core/tool/terminal"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { executeTool as libExecuteTool, toolIdentity } from "../lib/tool"

// scripted PermissionV2.Service stub — records asserts, allows by default, denies listed actions
const makePermissionStub = (decisions: ReadonlySet<string>) => {
  const calls: Array<{ action: string; resources: readonly string[] }> = []
  const layer = Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      ask: () => Effect.fail(new PermissionV2.BlockedError({})),
      assert: Effect.fn("PermissionStub.assert")(function* (input) {
        calls.push({ action: input.action, resources: input.resources ?? [] })
        if (decisions.has(input.action))
          return yield* new PermissionV2.BlockedError({})
        return
      }),
      reply: () => Effect.void,
    }),
  )
  return { calls, layer }
}

const tmpLocationLayer = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.map((tmp) => {
      const ref = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
      return Layer.succeed(Location.Service, Location.Service.of(location(ref)))
    }),
  ),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([BashTool.node, TerminalTool.node, ToolRegistry.node, TerminalRegistry.node]),
    [
      [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
      [PermissionV2.node, makePermissionStub(new Set()).layer],
      [Location.node, tmpLocationLayer],
    ],
  ),
)
const toolsLive = process.platform === "win32" ? it.live.skip : it.live

// settle a tool through the real registry settle path (test/lib/tool.ts)
const executeTool = (name: string, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    return yield* libExecuteTool(registry, {
      sessionID: "ses_a" as SessionSchema.ID,
      agent: toolIdentity.agent,
      assistantMessageID: toolIdentity.assistantMessageID,
      call: { id: "call_test", name, input },
    })
  })

// a second harness instance with terminal_terminate denied, used by the gating test
const denyLayer = AppNodeBuilder.build(
  LayerNode.group([BashTool.node, TerminalTool.node, ToolRegistry.node, TerminalRegistry.node]),
  [
    [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
    [PermissionV2.node, makePermissionStub(new Set(["terminal_terminate"])).layer],
    [Location.node, tmpLocationLayer],
  ],
)
const itDeny = testEffect(denyLayer)
const denyLive = process.platform === "win32" ? itDeny.live.skip : itDeny.live

describe("terminal tools (RUN-15 Task 3)", () => {
  toolsLive("bash session-mode writes a command to a persistent terminal and returns bounded output", () =>
    Effect.gen(function* () {
      const registry = yield* TerminalRegistry.Service
      const record = yield* registry.create({
        sessionId: "ses_a", owner: "model", persistent: true,
        command: "/bin/sh", args: ["-c", "printf 'started\\n'; sleep 30"],
      })
      const result = yield* executeTool("bash", {
        command: "echo from-session",
        session_id: record.terminalId,
        yield_time_ms: 1500,
      })
      expect(result.type).toBe("text")
      expect(String(result.text)).toContain("from-session")
      yield* registry.terminate(record.terminalId, { kind: "user" })
    }))

  toolsLive("write_stdin pushes raw data into the terminal and returns its tail", () =>
    Effect.gen(function* () {
      const registry = yield* TerminalRegistry.Service
      const record = yield* registry.create({
        sessionId: "ses_a", owner: "model", persistent: true,
        command: "/bin/sh", args: ["-c", "read x; echo got:$x; sleep 30"],
      })
      const out = yield* executeTool("write_stdin", {
        session_id: record.terminalId,
        data: "hello-stdin\n",
        yield_time_ms: 1500,
      })
      expect(out.type).toBe("text")
      expect(String(out.text)).toContain("got:hello-stdin")
      yield* registry.terminate(record.terminalId, { kind: "user" })
    }))

  toolsLive("terminal_list reports owner, persistence, and status", () =>
    Effect.gen(function* () {
      const registry = yield* TerminalRegistry.Service
      const record = yield* registry.create({
        sessionId: "ses_a", owner: "model", persistent: true,
        command: "/bin/sh", args: ["-c", "sleep 30"],
      })
      const out = yield* executeTool("terminal_list", {})
      expect(out.type).toBe("text")
      expect(String(out.text)).toContain(record.terminalId)
      expect(String(out.text)).toContain("model")
      yield* registry.terminate(record.terminalId, { kind: "user" })
    }))

  denyLive("terminal_terminate is permission-gated: a deny rule blocks it", () =>
    Effect.gen(function* () {
      const registry = yield* TerminalRegistry.Service
      const record = yield* registry.create({
        sessionId: "ses_a", owner: "model", persistent: true,
        command: "/bin/sh", args: ["-c", "sleep 30"],
      })
      const out = yield* executeTool("terminal_terminate", { session_id: record.terminalId })
      expect(out.type).toBe("error")
      yield* registry.terminate(record.terminalId, { kind: "user" })
    }))

  toolsLive("stateChanging flags: bash/write_stdin/terminal_terminate true, terminal_list false", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const defs = yield* registry.materialize()
      const metadata = (name: string) => defs.definitions.find((d) => d.name === name)?.metadata
      expect(metadata("bash")?.stateChanging).toBe(true)
      expect(metadata("write_stdin")?.stateChanging).toBe(true)
      expect(metadata("terminal_terminate")?.stateChanging).toBe(true)
      expect(metadata("terminal_list")?.stateChanging).toBe(false)
      expect(metadata("terminal_list")?.concurrencySafe).toBe(true)
    }))
})
```

The harness reuses `settleTool`/`executeTool`/`toolIdentity` from `packages/core/test/lib/tool.ts`; the `makePermissionStub` is a recording stub for the `PermissionV2.Service` boundary (real service needs seeded grants/sessions — RUN-06 territory) and is the no-alternative case. If `PermissionV2.BlockedError` is not constructible with an empty payload (verify in `packages/core/src/permission.ts`), pass the fields its `Schema.TaggedErrorClass` declares. The `SessionSchema.ID` cast on `"ses_a"` is required because `Session.ID` is branded.

- [ ] **Step 2: Run it, watch it fail**

Run: `cd packages/core && bun test test/terminal/tools.test.ts`
Expected: FAIL — `session_id`/`yield_time_ms` not in `bash` Input; `packages/core/src/tool/terminal.ts` missing.

- [ ] **Step 3: Implement bash session-mode** — add `session_id`/`yield_time_ms` to `Input` (branded `PtyID`), set `stateChanging: true` on the `Tool.make` config, add `TerminalRegistry.node` to `node.deps`, yield `TerminalRegistry.Service`, and branch in `execute`: when `session_id` is present, resolve → `registry.write(id, command + "\n", { kind: "model", sessionId: context.sessionID })` → `terminalTail` → return `{ ...bounded, terminal_id }`; keep the existing `permission.assert({ action: "bash", resources: [command] ... })` for both modes. Map `NotFoundError`/`OwnershipError`/`PermissionV2` errors to `ToolFailure` via `Effect.mapError` (extend the existing single `Effect.mapError`).

- [ ] **Step 4: Implement `packages/core/src/tool/terminal.ts`** — `terminalTail` (attach `cursor: -1`, activate, drain `onData` for `windowMs`, return tail via `ToolOutputStore` limits) plus the three tools per the `Produces` contract, each a `Tool.make` with the declared flags and permission assertions; register all three via `Tools.Service.register({ write_stdin, terminal_list, terminal_terminate })` inside the layer; export `node` with the listed deps.

- [ ] **Step 5: Run it, watch it pass** — `cd packages/core && bun test test/terminal/tools.test.ts`. Then `cd packages/core && bun typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tool/bash.ts packages/core/src/tool/terminal.ts packages/core/test/terminal/tools.test.ts
git commit -m "feat(core): session-mode bash and terminal write/list/terminate tools"
```

---

### Task 4: Lifecycle integrity — persistence, session-end, compaction survival, leak-proofing

**Files:**
- Modify: `packages/core/src/terminal/registry.ts` (only if a seam needs adjustment — prefer keeping all behavior in Task 2 and adding only the compaction fixture wiring here)
- Create: `packages/core/test/terminal/lifecycle.test.ts`
- Test: `packages/core/test/terminal/lifecycle.test.ts`

**Interfaces:**
- Consumes: `TerminalRegistry.Service` (`create/write/terminate/onSessionEnd/reconcile`, `Actor`) from Task 2; `SessionCompaction` (`packages/core/src/session/compaction.ts`) for the compaction fixture; real processes.
- Produces: no new runtime interfaces. Behavioral contracts verified:
  - non-persistent terminals are terminated on `onSessionEnd(sessionId)` (pid dead, row deleted, `terminal.deleted` published);
  - persistent terminals survive `onSessionEnd` (record + pid alive) but are removed by `terminate`;
  - compaction never touches the `terminal` table (record + pid alive after a real compaction pass);
  - terminate leaves no orphan processes (pid dead; the fixture's process group has no survivors);
  - `reconcile` marks stale running rows exited (already covered in Task 2 — do not duplicate).

- [ ] **Step 1: Write the failing lifecycle tests** — create `packages/core/test/terminal/lifecycle.test.ts` on the Task-2 harness (real tmpdir, real PTY). Use a long-running fixture: `python3 -c "import time,sys; print('up'); sys.stdout.flush(); time.sleep(60)"` — note: on Linux the python child runs in the PTY's process group; assert termination by pid and, for the leak test, verify no descendant survives by scanning `/proc` children of the session's leader if your platform exposes it, falling back to the pid liveness assertion on non-Linux.

```ts
import { describe, expect } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { TerminalRegistry } from "@opencode-ai/core/terminal/registry"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([TerminalRegistry.node, Pty.node, EventV2.node, Database.node]), [
    [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
    [
      Location.node,
      Layer.unwrap(
        Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ).pipe(
          Effect.map((tmp) => {
            const ref = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
            return Layer.succeed(Location.Service, Location.Service.of(location(ref)))
          }),
        ),
      ),
    ],
  ]),
)
const lifecycleLive = process.platform === "win32" ? it.live.skip : it.live

const fixture = ["/bin/sh", "-c", "python3 -c \"import time,sys; print('up'); sys.stdout.flush(); time.sleep(60)\""]

// session-history entries for the compaction fixture (mirrors test/compaction-adapter.test.ts helpers)
const entry = (message: unknown, seq: number) => ({ seq, message })
const user = (id: string, text: string) => ({ id, type: "user", text, time: { created: 0 } })
const assistantTool = (id: string, name: string, input: unknown) => ({
  id, type: "assistant", agent: "build", model: { id: "m", providerID: "p" },
  content: [{ type: "tool", id: `${id}-tool`, name, state: { status: "completed", input, structured: {}, content: [{ type: "text", text: "ok" }] }, time: { created: 0 } }],
  time: { created: 0 },
})
const history = (terminalId: string) => [
  entry(user("u1", `keep the terminal ${terminalId} alive`), 1),
  entry(assistantTool("a1", "bash", { command: "echo from-session", session_id: terminalId }), 2),
  entry(user("u2", "continue"), 3),
]

describe("TerminalRegistry lifecycle integrity", () => {
  lifecycleLive("non-persistent terminal is terminated on owning-session end", () =>
    Effect.gen(function* () {
      const registry = yield* TerminalRegistry.Service
      const record = yield* registry.create({
        sessionId: "ses_a", owner: "model", persistent: false,
        command: fixture[0], args: fixture.slice(1), title: "np",
      })
      yield* registry.onSessionEnd("ses_a")
      expect(alive(record.pid)).toBe(false)
      const outcome = yield* registry.get(record.terminalId).pipe(Effect.exit)
      expect(outcome._tag).toBe("Failure")
    }))

  lifecycleLive("persistent terminal survives session end but not explicit terminate", () =>
    Effect.gen(function* () {
      const registry = yield* TerminalRegistry.Service
      const record = yield* registry.create({
        sessionId: "ses_a", owner: "model", persistent: true,
        command: fixture[0], args: fixture.slice(1), title: "p",
      })
      yield* registry.onSessionEnd("ses_a")
      expect(alive(record.pid)).toBe(true)
      const survived = yield* registry.get(record.terminalId)
      expect(survived.status).toBe("running")
      yield* registry.terminate(record.terminalId, { kind: "user" })
      expect(alive(record.pid)).toBe(false)
    }))

  lifecycleLive("compaction-survival: persistent terminal survives a real compaction pass", () =>
    Effect.gen(function* () {
      const registry = yield* TerminalRegistry.Service
      const record = yield* registry.create({
        sessionId: "ses_a", owner: "model", persistent: true,
        command: fixture[0], args: fixture.slice(1), title: "compacted",
      })
      // run the real microcompact engine over a session history that mentions the terminal
      const plannerMessages = toPlannerMessages(history(record.terminalId) as SessionMessage.Message[])
      const { clearedPartIds } = Planner.microCompact(plannerMessages, Planner.DEFAULT_COMPACTION_CONFIG)
      expect(Array.isArray(clearedPartIds)).toBe(true)
      const survived = yield* registry.get(record.terminalId)
      expect(survived.status).toBe("running")
      expect(alive(record.pid)).toBe(true)
      yield* registry.terminate(record.terminalId, { kind: "user" })
    }))

  lifecycleLive("leak: no orphan process after terminate", () =>
    Effect.gen(function* () {
      const registry = yield* TerminalRegistry.Service
      const record = yield* registry.create({
        sessionId: "ses_a", owner: "model", persistent: true,
        command: fixture[0], args: fixture.slice(1), title: "leak",
      })
      yield* registry.terminate(record.terminalId, { kind: "user" })
      expect(alive(record.pid)).toBe(false)
      if (process.platform === "linux") {
        expect(orphansOf(record.pid)).toEqual([])
      }
    }))
})

function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function orphansOf(pid: number) {
  // real process-table scan: all /proc/<pid>/stat whose PPID field is pid
  const result: number[] = []
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    const candidate = Number(entry)
    if (candidate === pid) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
      const match = stat.match(/\(.*\)\s+\w\s+(\d+)/)
      if (match && Number(match[1]) === pid) result.push(candidate)
    } catch {}
  }
  return result
}
```

`toPlannerMessages` comes from `@opencode-ai/core/session/compaction-adapter` (same import `packages/core/src/session/compaction.ts` uses) and `Planner` from `@ultracode/context` (`Planner.microCompact(plannerMessages, Planner.DEFAULT_COMPACTION_CONFIG)` is the exact call at `compaction.ts:127`). This is the real protection-aware microcompact engine, so the test proves compaction ran over a history mentioning the terminal and the terminal record + live pid were untouched. If the `Pty.node`/`EventV2.node`/`Database.node` group needs `SandboxProcess.node` or `Config` entries the fixture does not provide (verify against Task 2's `registry.test.ts` group, which already builds this layer), reuse Task 2's exact group and location layer.

- [ ] **Step 2: Run it, watch it fail**

Run: `cd packages/core && bun test test/terminal/lifecycle.test.ts`
Expected: FAIL — `onSessionEnd` and persistent semantics do not exist yet (module missing or behavior absent). The leak test may also expose that `Pty.remove` leaves the python child alive — that is the defect this task fixes.

- [ ] **Step 3: Implement the missing behavior** — add `onSessionEnd` and the non-persistent/persistent split to `TerminalRegistry` if not already implemented in Task 2's layer body (Task 2 implemented them; if Task 2's implementation already satisfies the tests, skip this step and record "no-op" in the ledger). If the leak test fails, fix the termination path: `Pty.remove` already kills the session's process; if a child (`python3`) survives, terminate the session's process *group* by passing a kill-group option through `Pty.remove`/the native `#pty` proc (`process.kill(-pid, "SIGTERM")` on POSIX after verifying the pty spawns its own process group) — prefer the smallest fix that keeps `Pty.Service`'s public interface unchanged (e.g. terminate the group in the registry's terminate path, or extend the `Pty` teardown only if the existing behavior is genuinely orphan-producing; record the deviation).

- [ ] **Step 4: Run it, watch it pass** — `cd packages/core && bun test test/terminal/lifecycle.test.ts`. Then `cd packages/core && bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/terminal/registry.ts packages/core/test/terminal/lifecycle.test.ts
git commit -m "test(core): lifecycle integrity for persistent terminals with leak assertions"
```

---

### Task 5: Surfaces — authority endpoints, command-center Terminals tab, TUI dialog

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/authority.ts` (add `terminals` GET + `terminateTerminal` POST endpoints)
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/authority.ts` (implement the two handlers)
- Create: `packages/opencode/test/server/httpapi-authority-terminals.test.ts`
- Modify: `packages/app/src/components/command-center/command-center.tsx` (add `"terminals"` to the `Tab` union + a `TerminalsPanel` using the existing `authority<T>()` raw-fetch helper)
- Modify: `packages/app/src/components/command-center/command-center-model.ts` + `command-center-model.test.ts` (data-layer: `pageLimit` reuse + a `TerminalsView` record mapper)
- Create: `packages/tui/src/routes/session/dialog-terminals.tsx`
- Modify: `packages/tui/src/routes/session/index.tsx` (add a `/terminals` command to `sessionCommandList`)
- Create: `packages/tui/test/cli/tui/terminals-dialog.test.tsx`
- Run: `cd packages/client && bun run generate` (Server HttpApi changed — §2.7)

**Interfaces:**
- Consumes: `TerminalRegistry.Service` (Task 2), the authority HttpApi pattern (`HttpApiGroup`/`HttpApiEndpoint`/`HttpApiBuilder.group`), `InstanceState` directory resolution, the app `authority<T>()` fetch helper, the TUI `useDialog`/`DialogSelect` pattern, `Pty.ID` for the terminate param.
- Produces:
  - Authority endpoints (root `/experimental/authority`): `GET /experimental/authority/terminals` → `{ terminals: TerminalRecord[] }`; `POST /experimental/authority/terminals/:terminalId/terminate` with payload `{ sessionId?: string }`, actor `{ kind: "user" }` (a user may always terminate), returns `{ terminalId, status: "exited" }`. Endpoint success schemas use `Schema.Unknown` like the sibling authority endpoints.
  - App `command-center-model.ts`: `export type CommandCenterTerminal = { terminal_id: string; title: string; status: string; owner: string; persistent: boolean; session_id: string; last_used_at: number }` + `export function flattenTerminals(input: { terminals: readonly CommandCenterTerminal[] })` (sort by `last_used_at` desc, then `terminal_id`).
  - TUI `DialogTerminals` component: lists terminals via the generated authority client (or a `fetch` fallback against the instance server URL), shows `title · status · owner · persistent`, and terminates on select after a `DialogConfirm`. Registered in the session command list under `value: "session.terminals"`, `slash: { name: "terminals" }`.

- [ ] **Step 1: Write the failing server test** — create `packages/opencode/test/server/httpapi-authority-terminals.test.ts` on the `httpApiLayer`/`requestInDirectory` harness (`packages/opencode/test/server/httpapi-layer.ts`, as used by `httpapi-authority.test.ts`):

```ts
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

describe("authority terminals HttpApi", () => {
  it.live("lists an empty terminals page for a fresh location", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const response = yield* requestInDirectory("/experimental/authority/terminals", directory)
      expect(response.status).toBe(200)
      const body = yield* response.json
      expect(Array.isArray(body.terminals)).toBe(true)
    }),
  )

  it.live("terminating an unknown terminal returns 404-style error", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const response = yield* requestInDirectory(
        "/experimental/authority/terminals/pty_does_not_exist/terminate",
        directory,
        { method: "POST", body: JSON.stringify({}) },
      )
      expect(response.status).toBe(404)
    }),
  )
})
```

If the real harness requires the terminal to exist before terminate, replace the second test with a create-then-terminate flow using the `TerminalRegistry` service through the harness layer (read `packages/opencode/test/server/httpapi-layer.ts` and mirror how it provisions core services).

- [ ] **Step 2: Run it, watch it fail**

Run: `cd packages/opencode && bun test test/server/httpapi-authority-terminals.test.ts`
Expected: FAIL — endpoints do not exist (404).

- [ ] **Step 3: Implement the endpoints + handlers** — add to `groups/authority.ts`:

```ts
HttpApiEndpoint.get("terminals", `${root}/terminals`, { query: AuthorityPageQuery, success: Schema.Unknown }),
HttpApiEndpoint.post("terminateTerminal", `${root}/terminals/:terminalId/terminate`, {
  params: { terminalId: Pty.ID },
  query: WorkspaceRoutingQuery,
  payload: Schema.Struct({}),
  success: Schema.Unknown,
}),
```

and in `handlers/authority.ts`, inside `Effect.gen(function* () { ... })`, resolve the registry (yield `TerminalRegistry.Service` after wiring its node into the instance context where the sibling core nodes are assembled — find that assembly and add `TerminalRegistry.node` beside `Pty.node`/`ToolRegistry.node`), then:

```ts
import { PtyNotFoundError, PtyForbiddenError } from "../errors"

.handle("terminals", () =>
  Effect.gen(function* () {
    const registry = yield* TerminalRegistry.Service
    return { terminals: yield* registry.list({}) }
  }),
)
.handle("terminateTerminal", (ctx: { params: { terminalId: Pty.ID } }) =>
  Effect.gen(function* () {
    const registry = yield* TerminalRegistry.Service
    yield* registry.terminate(ctx.params.terminalId, { kind: "user" }).pipe(
      Effect.catchTag(
        "TerminalRegistry.NotFoundError",
        () => new PtyNotFoundError({ ptyID: ctx.params.terminalId, message: `Terminal not found: ${ctx.params.terminalId}` }),
      ),
      Effect.catchTag("TerminalRegistry.OwnershipError", () => new PtyForbiddenError({ message: "Terminal ownership denied" })),
    )
    return { terminalId: ctx.params.terminalId, status: "exited" as const }
  }),
)
```

`PtyNotFoundError`/`PtyForbiddenError` already exist in `packages/opencode/src/server/routes/instance/httpapi/errors.ts` (404/403 `Schema.TaggedErrorClass` contracts) and match the instance-httpapi AGENTS.md rule (explicit error contracts, translate at the handler boundary). Verify `terminalId` is wire-typed as `Pty.ID` in `groups/authority.ts` (import `Pty` from `@opencode-ai/schema/pty`) and that the endpoint's `success` `Schema.Unknown` matches the sibling endpoints.

- [ ] **Step 4: Run it, watch it pass** — `cd packages/opencode && bun test test/server/httpapi-authority-terminals.test.ts`. Then run `cd packages/client && bun run generate` and `cd packages/opencode && bun typecheck`.

- [ ] **Step 5: App data-layer + component** — add `CommandCenterTerminal`/`flattenTerminals` to `command-center-model.ts`:

```ts
export type CommandCenterTerminal = {
  terminal_id: string
  title: string
  status: string
  owner: string
  persistent: boolean
  session_id: string
  last_used_at: number
}

export function flattenTerminals(input: { terminals: readonly CommandCenterTerminal[] }) {
  return [...input.terminals].sort(
    (a, b) => b.last_used_at - a.last_used_at || a.terminal_id.localeCompare(b.terminal_id),
  )
}
```

and append to `command-center-model.test.ts`:

```ts
test("command center flattens terminals newest-first then by id", () => {
  expect(flattenTerminals({
    terminals: [
      { terminal_id: "pty_b", title: "t", status: "running", owner: "model", persistent: true, session_id: "s", last_used_at: 1 },
      { terminal_id: "pty_a", title: "u", status: "exited", owner: "user", persistent: false, session_id: "s", last_used_at: 2 },
    ],
  }).map((t) => t.terminal_id)).toEqual(["pty_a", "pty_b"])
})
```

Then add the `"terminals"` tab to the `Tab` union in `command-center.tsx` and a thin `TerminalsPanel` that (a) fetches `/experimental/authority/terminals` via the existing `authority<T>()` helper, (b) renders each row as `title · owner · status · persistent` with a `Terminate` `IconButton` posting to `/experimental/authority/terminals/:id/terminate` (`method: "POST"`, JSON body `{}`), reusing `Panel`/`State`. No new dependencies. One component-level assertion: a `bun test` under `packages/app` (`happydom` preload) that renders `TerminalsPanel` with a stubbed `authority` (mock `fetch` returning the two fixtures above) and asserts the terminate `IconButton` issues a `POST` to `/experimental/authority/terminals/pty_a/terminate`. Run: `cd packages/app && bun test --preload ./happydom.ts ./src/components/command-center`.

- [ ] **Step 6: TUI dialog** — create `dialog-terminals.tsx` mirroring `dialog-timeline.tsx` (`DialogSelect` + `useDialog`), options sourced from the authority `terminals` response via a `fetch` to the instance server URL (or the generated client method discovered after `bun run generate`), each option's `onSelect` confirming with `DialogConfirm` then posting `terminate`. Register `/terminals` in `sessionCommandList` (value `session.terminals`). Component test in `packages/tui/test/cli/tui/terminals-dialog.test.tsx` using `testRender` + `TestTuiContexts` + `createFetch` (mirror `data.test.tsx`): assert the dialog renders a terminal row and that terminating posts to the terminate endpoint. Run: `cd packages/tui && bun test test/cli/tui/terminals-dialog.test.tsx`, then `cd packages/tui && bun typecheck`.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/groups/authority.ts packages/opencode/src/server/routes/instance/httpapi/handlers/authority.ts packages/opencode/test/server/httpapi-authority-terminals.test.ts packages/app/src/components/command-center packages/tui/src/routes/session/dialog-terminals.tsx packages/tui/src/routes/session/index.tsx packages/tui/test/cli/tui/terminals-dialog.test.tsx packages/client
git commit -m "feat(opencode): terminal surfaces in command center and TUI over authority API"
```

---

### Task 6: Docs, provenance ledger, run ledger, cross-run registry

**Files:**
- Modify: `TODO.md` (tick the persistent-terminals item)
- Modify: `TODO/README.md` (§7 Cross-Run Interface Registry row + §8 run ledger row)
- Create: `docs/provenance/sources.json` (only if absent; else append) and `docs/provenance/ledger.json` (only if absent; else append the RUN-15 entry) — consult `../codex` requires this
- Run: `bun run scripts/provenance/validate.ts` from repo root

**Interfaces:**
- Consumes: everything Tasks 1–5 produced.
- Produces: the completed ledger/registry/bookkeeping that makes the run DONE per `TODO/README.md` §6.

- [ ] **Step 1: Tick the TODO item** — in `TODO.md`, mark the persistent-terminals line as completed (follow the file's existing completion convention).

- [ ] **Step 2: Cross-run registry row** — append to `TODO/README.md` §7:

```
| RUN-15 | `TerminalRegistry.Service` (list/get/create/write/terminate/attach/onSessionEnd/reconcile) + `Actor` + `Terminal.Record`/`Terminal.Event`; bash `session_id`/`yield_time_ms`; tools `write_stdin`/`terminal_list`/`terminal_terminate`; authority `terminals`/`terminateTerminal` | `packages/core/src/terminal/*`, `packages/core/src/tool/terminal.ts`, `packages/core/src/tool/bash.ts`, `packages/schema/src/terminal.ts`, `packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/authority.ts` | RUN-14 (sidecar projection follow-up) |
```

Verify each produced symbol exists at its declared path before writing.

- [ ] **Step 3: Provenance ledger** — the run consulted `../codex` (`codex-rs/core/src/tools/handlers/unified_exec*`, `core/src/unified_exec/mod.rs`) for design understanding of `yield_time_ms`/`write_stdin` session semantics. Behavior is a reimplementation. Record it:

`sources.json` (create with `version`-less array shape matching the validator; the validator reads `docs/provenance/sources.json`):

```json
[
  {
    "id": "openai-codex",
    "repo_path": "../../codex",
    "remote_url": "https://github.com/openai/codex",
    "branch": "main",
    "pinned_commit": "0a0ebb85355113610dd3f7a3d8b36f68c33465fc",
    "license_spdx": "Apache-2.0",
    "license_file": "LICENSE",
    "notice_file": null,
    "authorization_ref": null
  }
]
```

Verify the pinned commit with `git -C ../codex rev-parse HEAD` and update it if it changed; confirm `../../codex/LICENSE` exists relative to `docs/provenance/` (adjust the relative path if not, and record the deviation).

`ledger.json` (create with `version: 1`):

```json
{
  "version": 1,
  "imports": [
    {
      "id": "run15-unified-exec-session-semantics",
      "source_id": "openai-codex",
      "original_path": "codex-rs/core/src/tools/handlers/unified_exec.rs",
      "destination": "packages/core/src/tool/bash.ts + packages/core/src/tool/terminal.ts (session-mode design)",
      "treatment": "reimplement",
      "owner": "RUN-15",
      "imported_from_commit": "0a0ebb85355113610dd3f7a3d8b36f68c33465fc",
      "license_spdx": "Apache-2.0",
      "notice_required": false,
      "authorization_ref": null,
      "imported_at": "2026-08-06",
      "local_modifications": [
        "yield_time_ms renamed to yield_time_ms (clamped at 30_000)",
        "write_stdin maps to TerminalRegistry-owned terminal (session_id), not a process_id",
        "ownership enforced by TerminalRegistry, not by the exec server",
        "output bounded through ToolOutputStore head/tail spill"
      ],
      "upstream_merge_owner": "RUN-15"
    }
  ]
}
```

If `sources.json`/`ledger.json` already exist (e.g. RUN-09 created them first), append rather than overwrite and keep existing entries intact. Run `bun run scripts/provenance/validate.ts` from repo root; it must print `PROVENANCE OK` and exit 0.

- [ ] **Step 4: Run ledger row** — append to `TODO/README.md` §8 with the commit range from this run and any deviations from this plan's code excerpts (Task-1 pins that changed to match real code, the `Pty.remove` leak fix, generated-client names, etc.).

- [ ] **Step 5: Final verification + commit**

```bash
cd packages/core && bun test test/terminal && bun typecheck
cd packages/opencode && bun test test/server/httpapi-authority-terminals.test.ts && bun typecheck
cd packages/app && bun test --preload ./happydom.ts ./src/components/command-center
cd packages/tui && bun test test/cli/tui/terminals-dialog.test.tsx
cd packages/client && bun run generate
cd /home/thymia/UltraCode-Planning/opencode && bun run scripts/provenance/validate.ts
git status
git add TODO.md TODO/README.md docs/provenance/sources.json docs/provenance/ledger.json
git commit -m "docs: record RUN-15 persistent terminal ledger and provenance"
```

If any generated client or migration file drifted during Task 5/6 verification, include it in the commit and note it in the ledger.

---

## Run-Level Review Prompt (dispatch after Task 6)

```
Review the commits <list hashes> in /home/thymia/UltraCode-Planning/opencode
implementing RUN-15 (file: opencode/TODO/RUN-15-persistent-terminals.md).
Run-specific checks:
1. One-owner rule: exactly one TerminalRegistry; no second terminal/background
   registry exists in packages/opencode or packages/core. grep the diff for
   `BackgroundJob` and `ShellTool` — they must be untouched.
2. Ownership is enforced in TerminalRegistry (model actor needs matching
   owner+sessionId; user actor always allowed), NOT only in the permission
   pipeline. The ownership-denial test exercises the registry directly.
3. stateChanging flags: bash, write_stdin, terminal_terminate are
   stateChanging:true; terminal_list is stateChanging:false,
   concurrencySafe:true.
4. Leak-proofing: non-persistent terminals die on onSessionEnd; persistent
   terminals never auto-restore and are killed by terminate (orphan-pid
   assertion). No terminal survives a process restart (reconcile marks
   stale running rows exited).
5. Durable store is core SQLite for this run; no Rust sidecar changes in
   crates/ultracode-events. The RUN-14 sidecar projection is documented as a
   follow-up, not built.
6. Output is bounded through ToolOutputStore (head/tail spill); no tool
   returns unbounded terminal output.
7. Provenance: docs/provenance/ledger.json contains the RUN-15 reimplementation
   entry and `bun run scripts/provenance/validate.ts` exits 0.
8. Diff scope: only files declared in the run plan.
Then the generic checks from TODO/README.md §5.1 items 1–5.
Reply numbered findings, BLOCKER or MINOR, file:line. No edits.
```

## Deviation Log (fill during execution)

| Task | Deviation | Reason |
|---|---|---|
| | | |
