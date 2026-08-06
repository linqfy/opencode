# RUN-08: Streaming-Parallel Tool Execution + Speculative Permission Evaluation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute concurrency-safe tool calls as their inputs complete during the provider stream (bounded by config), serialize state-changing tools in recorded order with sibling-abort on failure, start approval evaluation at call-record time, and coalesce live-only stream deltas — while preserving the exact durable record-before-effect audit trail.

**Architecture:** A pure scheduling decider (`packages/core/src/tool/schedule.ts`) turns recorded calls + declared `stateChanging`/`concurrencySafe` metadata into a run plan and a `mayStart` predicate; a per-turn `SettlementExecutor` (`packages/core/src/session/runner/settlement.ts`) dispatches tool fibers through that policy with bounded concurrency and sibling-abort. A `SpeculativeEvaluation` service starts the RUN-06 approval pipeline at call-record time, cached per call id, with the final verdict still awaited before side effects. Live-only text/reasoning/tool-input deltas are coalesced through a bounded `DeltaBuffer` flushed on boundaries.

**Tech Stack:** Bun, TypeScript, Effect-TS (FiberSet, Semaphore, Stream), Drizzle/SQLite (durable event assertions), seeded PRNG in tests.

**Audit basis:** §13 (streaming tools row), §15 (Codex FuturesOrdered inline dispatch), §16 (Claude StreamingToolExecutor + sibling-abort + speculative classifier), §18-A6 (during-streaming tool execution + sibling-abort), §17 item 3.

---

## Global Constraints

All constraints in `TODO/README.md` §2 apply verbatim. In addition:

- **Durable order invariant (audit-trail law):** tool-call events are durably recorded (`SessionEvent.Tool.Called`) in provider-stream order, before any side effect, regardless of execution or settlement order. No task may reorder the `publish(event)` call ahead of settlement dispatch.
- **One-owner rule:** `ToolRegistry.Materialization.settle` remains the single executor. `SettlementExecutor` decides *when* to call it, never *what* it does. `schedule.ts` stays pure (no Effect, no services, no wall-clock).
- **Determinism:** execution-start decisions are a pure function of (recorded calls, metadata, config `tools.maxConcurrency`). No timers, no `Date.now`, no random scheduling in production code. Randomness exists only inside tests (seeded PRNG).
- **Interruption semantics unchanged:** unsettled tools on interrupt fail durably with `Tool execution interrupted`; settled tools are never re-failed; abandonment is never silently replayed (specs/v2/session.md §Settlement).
- **Reference sources:** consult `../claude-code-sourcemap/restored-src/src/services/tools/StreamingToolExecutor.ts`, `.../BashTool/bashPermissions.ts`, and `../codex/codex-rs/core/src/session/turn.rs` for *behavior only*. Reimplement; never copy text. Record provenance entries in `docs/provenance/ledger.json` (Task 8).
- **Branch:** `streaming-tools`. Conventional commits, `core` scope.
- **Config:** `tools.maxConcurrency` default 8. Revisit via `Config.latest(entries, "tools")?.maxConcurrency ?? 8`.
- **RUN-06 seam:** RUN-08 consumes RUN-06's `ApprovalPipeline` (`TODO/README.md` §7). RUN-06 is NOT merged; RUN-08 implements its speculative timing against the *documented seam* and adapts in Task 5 to the current `PermissionV2` surface with accommodations that RUN-06 must honor. Do not build a second approval pipeline.

---

## Orchestrator Brief

### Context Files (read in full before dispatching Task 1)

1. `packages/core/src/session/runner/llm.ts` — the V2 settlement region (lines ~243–356: tool-call handler, `awaitToolFibers`, interrupt paths; lines ~192–193 FiberSet; lines ~211 tool materialization).
2. `packages/core/src/tool/tool.ts` — `Definition.stateChanging`/`concurrencySafe` (lines 20–28), `Config` shape (43–67), `Runtime` (69–73), `make` (77–147).
3. `packages/core/src/tool/registry.ts` — `Materialization` interface (30–39), `settleWith` (53–85), `materialize` (109–168).
4. `packages/core/src/session/runner/publish-llm-event.ts` — `publish` switch (239–409), `failUnsettledTools` (213–232), fragments (91–163).
5. `packages/core/src/permission.ts` — `evaluateInput` (204–238), `create` (270–282), `assert` (291–312), `reply` (314–413).
6. `packages/core/src/config.ts` — `Info` schema (29–110), `latest` (125–129).
7. `specs/v2/session.md` — lines 50, 173, 189, 210 (Settlement / "intentionally unbounded" passages).
8. Existing runner harness: `packages/core/test/session-runner.test.ts` (lines 1–300; the layer stack and `setup`), `packages/core/test/session-runner-tool-events.test.ts` (recorded-event capture pattern), `packages/core/test/lib/{effect,tool}.ts`.
9. Reference behavior (read-only): `../claude-code-sourcemap/restored-src/src/services/tools/StreamingToolExecutor.ts`, `.../BashTool/bashPermissions.ts` (speculative map at 1480+), `../codex/codex-rs/core/src/session/turn.rs` (`FuturesOrdered` at 2190+).

### Baselines (record before Task 1)

```bash
cd packages/core && bun typecheck 2>&1 | tail -5
cd packages/core && bun test test/session-runner.test.ts test/session-runner-tool-events.test.ts test/tool-registry.test.ts 2>&1 | tail -5
git -C . status --short   # expect only `?? TODO/` untracked
```

### Dispatch Order

Tasks 1 → 8 strictly sequential. Tasks 1 and 2 share no files; still run in order. Every task ends with a commit; never `git add -A`.

### Definition of Done (verify each with a command you ran)

- [ ] `bun test test/session-runner-streaming.test.ts` passes — durable `Tool.Called` order == stream order under reverse completion order; interrupt semantics unchanged.
- [ ] `bun test test/tool-schedule.test.ts` passes — `plan`/`mayStart` pure decider over declared metadata.
- [ ] `bun test test/session-runner-scheduler.test.ts` passes — bounded concurrency (`maxConcurrency`, default 8), stateChanging exclusivity + recorded order, `Materialization.metadata` consumed.
- [ ] `bun test test/session-runner-sibling-abort.test.ts` passes — a failing stateChanging call durably fails pending concurrencySafe siblings with `aborted after sibling failure`; non-stateChanging failures abort nothing.
- [ ] `bun test test/permission-speculative.test.ts` passes — evaluation begins at call-record time, cached per call id, verdict awaited before side effects, exactly one approval prompt per call.
- [ ] `bun test test/delta-buffer.test.ts` passes — bounded coalescing with flush-on-boundary and flush-on-fragment-end; order preserved.
- [ ] `bun test test/session-runner-order-invariant.test.ts` passes — **seeded property test**: randomized interleavings (≥64 seeds) keep durable record order == stream order, exactly one terminal durable event per local call, sibling-abort only on concurrencySafe calls recorded after a failing stateChanging call, concurrency ≤ `maxConcurrency`.
- [ ] `bun run scripts/provenance/validate.ts` passes from repo root after Task 8 ledger work.
- [ ] `bun typecheck` passes in `packages/core`.
- [ ] `specs/v2/session.md` no longer claims "intentionally unbounded"; `TODO/README.md` §7 registry has RUN-08's produced-interface row.

---

### Task 1: Baseline characterization of settlement ordering + interruption

**Files:**
- Create: `packages/core/test/lib/streaming-runner.ts` (shared harness: fake gated LLM client, layers, deferred-gate tools)
- Create: `packages/core/test/session-runner-streaming.test.ts`

**Interfaces:**
- Consumes: existing runner harness patterns from `session-runner.test.ts` (fake `LLMClient`, `echo` layer, `setup` reset); `Tool.make` metadata fields (already present in `tool.ts`).
- Produces:
  - `streamingRunner` test harness: `{ layer: Layer.Layer<...>, it, controls }` where `controls` exposes `response`, `responseStream`, `gates: Map<string, Deferred.Deferred<void>>`, `started: Deferred.Deferred<void>`, `executions: string[]`, `activeCount`/`maxActive`, `setMaxConcurrency(n)`, `durableToolEvents(sessionID)` returning `ReadonlyArray<{ type: string; data: Record<string, unknown> }>` ordered by `seq`.
  - `session-runner-streaming.test.ts` characterization tests that document (and lock) the current durable-order + interruption invariants. **These tests must keep passing through Tasks 3–7.**

- [ ] **Step 1: Write the harness** — `test/lib/streaming-runner.ts`. Mirror the layer stack from `session-runner.test.ts` lines 1–296 (fake LLM client with `Stream.fromIterable`/`Stream.concat`, `echoNode`, `models`, `systemContext`, `skillGuidance`, `referenceGuidance`, `config`, `runnerLayer`, `execution`, the `LayerNode.group` build). Deltas:

```ts
// packages/core/test/lib/streaming-runner.ts (deltas only — base the rest on session-runner.test.ts 1–296)
import { ConfigTools } from "@opencode-ai/core/config/tools"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Database } from "@opencode-ai/core/database/database"
import { asc, eq } from "drizzle-orm"

let maxConcurrency = 8
export const gates = new Map<string, Deferred.Deferred<void>>()
export const executions: string[] = []
let active = 0
let maxActive = 0
let started: Deferred.Deferred<void> | undefined
let ready = 1

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({ buffer: 3_000, keep: new ConfigCompaction.Keep({ tokens: 1_000 }) }),
            tools: new ConfigTools.Info({ maxConcurrency }),
          }),
        }),
      ]),
  }),
)

export const deferredTool = (name: string, metadata: { stateChanging: boolean; concurrencySafe: boolean }) =>
  Tool.make({
    ...metadata,
    description: `Deferred ${name}`,
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
    execute: ({ text }, context) =>
      Effect.gen(function* () {
        executions.push(context.toolCallID)
        active++
        maxActive = Math.max(maxActive, active)
        const gate = gates.get(context.toolCallID)
        if (gate) yield* Deferred.await(gate)
        if (executions.length === ready && started) yield* Deferred.succeed(started, undefined)
        return { text }
      }).pipe(Effect.ensuring(Effect.sync(() => active--))),
  })

const echoLayer = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: deferredTool("echo", { stateChanging: false, concurrencySafe: true }),
      stateful: deferredTool("stateful", { stateChanging: true, concurrencySafe: false }),
    }),
  ),
)

export const durableToolEvents = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select({ type: EventTable.type, data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .orderBy(asc(EventTable.seq))
      .run()
    return rows.filter((row) => row.type === "session.next.tool.called.1" || row.type === "session.next.tool.success.1" || row.type === "session.next.tool.failed.1")
  })

export const resetStreamingRunner = () => {
  gates.clear()
  executions.length = 0
  active = 0
  maxActive = 0
  started = undefined
  ready = 1
  maxConcurrency = 8
}
```

The harness must additionally export: `it` (built via `testEffect(layer)` from `test/lib/effect.ts`), the module-level mutable `requests`, `response`, `responses`, `responseStream` variables (mirroring `session-runner.test.ts` lines 62–66), a `setup` effect that runs `resetStreamingRunner()` plus the existing `setup` reset from `session-runner.test.ts` (insert `ProjectTable`/`SessionTable` rows, clear `requests`/`response`/`responses`), `sessionID`, and `insertSession(id: SessionV2.ID)` (from `session-runner.test.ts` lines 300–316).

- [ ] **Step 2: Write the failing characterization tests** — `test/session-runner-streaming.test.ts`. These assert current behavior and become the conformance baseline. **They should pass against the current code** (they characterize it); the "failing test" discipline applies to Tasks 2–7, not this characterization task.

```ts
// packages/core/test/session-runner-streaming.test.ts
import { expect } from "bun:test"
import { LLMEvent } from "@opencode-ai/llm"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { durableToolEvents, executions, gates, it, requests, responses, responseStream, resetStreamingRunner, setup, sessionID } from "./lib/streaming-runner"

it.effect("records durable tool calls in stream order regardless of completion order", () =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Order" }), resume: false })
    const order = ["call-a", "call-b", "call-c"]
    gates.set("call-a", yield* Deferred.make())
    gates.set("call-b", yield* Deferred.make())
    gates.set("call-c", yield* Deferred.make())
    // responses[0] = the tool-call turn; responses[1] = the empty continuation turn the runner opens after local settlement
    responses = [
      [
        LLMEvent.stepStart({ index: 0 }),
        ...order.map((id) => LLMEvent.toolCall({ id, name: "echo", input: { text: id } })),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ],
      [],
    ]
    const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
    while (executions.length < 3) yield* Effect.yieldNow
    // release in REVERSE completion order
    yield* Deferred.succeed(gates.get("call-c")!, undefined)
    yield* Deferred.succeed(gates.get("call-b")!, undefined)
    yield* Deferred.succeed(gates.get("call-a")!, undefined)
    yield* Fiber.join(run)

    const called = yield* durableToolEvents(sessionID)
    expect(called.filter((e) => e.type === "session.next.tool.called.1").map((e) => (e.data as { callID: string }).callID)).toEqual(order)
  }),
)

it.effect("durably fails unsettled tools with Tool execution interrupted on interrupt", () =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt" }), resume: false })
    gates.set("call-gated", yield* Deferred.make())
    responses = [
      [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-gated", name: "echo", input: { text: "blocked" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ],
      [],
    ]
    const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
    while (executions.length === 0) yield* Effect.yieldNow
    yield* session.interrupt(sessionID)
    expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
    const events = yield* durableToolEvents(sessionID)
    const failed = events.find((e) => e.type === "session.next.tool.failed.1")
    expect((failed?.data as { error: { message: string } }).error.message).toBe("Tool execution interrupted")
    expect(events.filter((e) => e.type === "session.next.tool.success.1")).toHaveLength(0)
  }),
)

it.effect("awaits all started settlements before continuation", () =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Gate then continue" }), resume: false })
    gates.set("call-gated", yield* Deferred.make())
    const providerGate = yield* Deferred.make<void>()
    responseStream = Stream.concat(
      Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-gated", name: "echo", input: { text: "blocked" } }),
      ]),
      Stream.fromEffect(Deferred.await(providerGate)).pipe(Stream.flatMap(() =>
        Stream.fromIterable([LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }), LLMEvent.finish({ reason: "tool-calls" })])),
      ),
    )
    const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
    while (executions.length === 0) yield* Effect.yieldNow
    yield* Deferred.succeed(providerGate, undefined)
    yield* Effect.yieldNow
    expect(requests).toHaveLength(1) // second provider turn NOT started while a tool is unsettled
    yield* Deferred.succeed(gates.get("call-gated")!, undefined)
    yield* Fiber.join(run)
    expect(requests).toHaveLength(2)
  }),
)
```

- [ ] **Step 3: Run, verify the characterization holds against current code**

Run: `cd packages/core && bun test test/session-runner-streaming.test.ts`
Expected: 3 pass. If a test fails, it is capturing a real behavior difference — STOP and read the settlement region again; do not weaken the assertion. The `response`/`requests`/`responseStream` variables and `sessionID`/`setup` come from the harness; export them from `streaming-runner.ts`.

- [ ] **Step 4: Typecheck** — `cd packages/core && bun typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/core/test/lib/streaming-runner.ts packages/core/test/session-runner-streaming.test.ts
git commit -m "test(core): characterize settlement ordering and interrupt behavior"
```

---

### Task 2: Scheduling policy module — pure decider over recorded calls + metadata

**Files:**
- Create: `packages/core/src/tool/schedule.ts`
- Modify: `packages/core/src/tool/tool.ts` (export `ScheduleMetadata`)
- Modify: `packages/core/src/tool/registry.ts` (`Materialization.metadata(name)` accessor)
- Test: `packages/core/test/tool-schedule.test.ts`

**Interfaces:**
- Consumes: `Tool.Definition.stateChanging`/`concurrencySafe` fields (`tool.ts:26-27`); `ToolRegistry.Materialization` (`registry.ts:30-39`).
- Produces:
  - `packages/core/src/tool/tool.ts`: `export interface ScheduleMetadata { readonly stateChanging: boolean; readonly concurrencySafe: boolean }`.
  - `packages/core/src/tool/schedule.ts`:
    ```ts
    import type { ScheduleMetadata } from "./tool"
    export interface ScheduledCall<M extends ScheduleMetadata = ScheduleMetadata> {
      readonly id: string
      readonly name: string
      readonly metadata: M
    }
    export type RunSegment<M extends ScheduleMetadata = ScheduleMetadata> =
      | { readonly _tag: "exclusive"; readonly call: ScheduledCall<M> }
      | { readonly _tag: "parallel"; readonly calls: ReadonlyArray<ScheduledCall<M>> }
    export type RunPlan<M extends ScheduleMetadata = ScheduleMetadata> = ReadonlyArray<RunSegment<M>>
    export const isStateChanging: (metadata: ScheduleMetadata) => boolean           // metadata.stateChanging
    export const isExclusive: (metadata: ScheduleMetadata) => boolean              // metadata.stateChanging || !metadata.concurrencySafe
    export const plan: <M extends ScheduleMetadata>(calls: ReadonlyArray<ScheduledCall<M>>) => RunPlan<M>
    export const mayStart: (opts: {
      readonly call: ScheduledCall
      readonly recorded: ReadonlyArray<ScheduledCall>   // stream order, must include `call`
      readonly settled: ReadonlySet<string>             // settled call ids
      readonly active: ReadonlySet<string>              // currently-executing call ids
      readonly maxConcurrency: number
    }) => boolean
    ```
  - `registry.ts` `Materialization`: `readonly metadata: (name: string) => ScheduleMetadata | undefined` — returns `{ stateChanging, concurrencySafe }` of the effective registered tool, or `undefined` for unknown names.

- [ ] **Step 1: Write the failing test** — `test/tool-schedule.test.ts`:

```ts
// packages/core/test/tool-schedule.test.ts
import { describe, expect, test } from "bun:test"
import { plan, mayStart, isExclusive, type ScheduledCall } from "../src/tool/schedule"

const call = (id: string, stateChanging: boolean, concurrencySafe: boolean): ScheduledCall => ({
  id,
  name: id.split("-")[0]!,
  metadata: { stateChanging, concurrencySafe },
})
const ids = (seg: { readonly calls?: ReadonlyArray<ScheduledCall>; readonly call?: ScheduledCall }) =>
  "calls" in seg ? seg.calls!.map((c) => c.id) : [seg.call!.id]

describe("plan", () => {
  test("groups maximal runs of concurrencySafe calls and isolates stateChanging calls", () => {
    const calls = [
      call("r1", false, true),
      call("r2", false, true),
      call("w1", true, false),
      call("r3", false, true),
      call("w2", true, false),
    ]
    const segments = plan(calls)
    expect(segments.map((s) => ({ tag: s._tag, ids: ids(s) }))).toEqual([
      { tag: "parallel", ids: ["r1", "r2"] },
      { tag: "exclusive", ids: ["w1"] },
      { tag: "parallel", ids: ["r3"] },
      { tag: "exclusive", ids: ["w2"] },
    ])
  })

  test("a call with neither flag is exclusive (fail-safe default)", () => {
    expect(plan([call("unknown", false, false)])[0]).toEqual({ _tag: "exclusive", call: call("unknown", false, false) })
    expect(isExclusive({ stateChanging: false, concurrencySafe: false })).toBe(true)
  })

  test("plan is prefix-consistent: planning a prefix equals the full plan sliced to that prefix", () => {
    const full = [call("r1", false, true), call("r2", false, true), call("w1", true, false), call("r3", false, true)]
    const fullPlan = plan(full)
    for (let n = 1; n <= full.length; n++) {
      const prefixPlan = plan(full.slice(0, n))
      const slice: RunSegment[] = []
      for (const segment of fullPlan) {
        const keep = segment._tag === "exclusive"
          ? [segment.call]
          : segment.calls.filter((c) => full.slice(0, n).some((p) => p.id === c.id))
        if (keep.length === 0) continue
        slice.push(segment._tag === "exclusive" ? { _tag: "exclusive", call: keep[0]! } : { _tag: "parallel", calls: keep })
      }
      expect(prefixPlan).toEqual(slice)
    }
  })
})

describe("mayStart", () => {
  test("parallel calls start while other parallel calls run, bounded by maxConcurrency", () => {
    const recorded = [call("r1", false, true), call("r2", false, true)]
    expect(mayStart({ call: recorded[1]!, recorded, settled: new Set(), active: new Set(["r1"]), maxConcurrency: 8 })).toBe(true)
    expect(mayStart({ call: recorded[1]!, recorded, settled: new Set(), active: new Set(["r1"]), maxConcurrency: 1 })).toBe(false)
  })

  test("exclusive calls wait for every prior call to settle", () => {
    const recorded = [call("r1", false, true), call("w1", true, false)]
    expect(mayStart({ call: recorded[1]!, recorded, settled: new Set(["r1"]), active: new Set(), maxConcurrency: 8 })).toBe(true)
    expect(mayStart({ call: recorded[1]!, recorded, settled: new Set(), active: new Set(["r1"]), maxConcurrency: 8 })).toBe(false)
  })

  test("parallel calls recorded after a stateChanging call wait for it to settle", () => {
    const recorded = [call("w1", true, false), call("r1", false, true)]
    expect(mayStart({ call: recorded[1]!, recorded, settled: new Set(["w1"]), active: new Set(), maxConcurrency: 8 })).toBe(true)
    expect(mayStart({ call: recorded[1]!, recorded, settled: new Set(), active: new Set(["w1"]), maxConcurrency: 8 })).toBe(false)
  })

  test("parallel calls recorded before a stateChanging call run while it waits (no deadlock)", () => {
    const recorded = [call("r1", false, true), call("r2", false, true), call("w1", true, false)]
    expect(mayStart({ call: recorded[1]!, recorded, settled: new Set(), active: new Set(["r1"]), maxConcurrency: 8 })).toBe(true)
    expect(mayStart({ call: recorded[2]!, recorded, settled: new Set(), active: new Set(["r1", "r2"]), maxConcurrency: 8 })).toBe(false)
  })
})
```

- [ ] **Step 2: Run it, watch it fail** — `cd packages/core && bun test test/tool-schedule.test.ts` → module `../src/tool/schedule` missing.

- [ ] **Step 3: Write minimal implementation** — `src/tool/schedule.ts` (pure; no Effect):

```ts
export const isStateChanging = (metadata: ScheduleMetadata) => metadata.stateChanging
export const isExclusive = (metadata: ScheduleMetadata) => metadata.stateChanging || !metadata.concurrencySafe

export const plan = <M extends ScheduleMetadata>(calls: ReadonlyArray<ScheduledCall<M>>): RunPlan<M> => {
  const segments: RunSegment<M>[] = []
  for (const call of calls) {
    const last = segments.at(-1)
    if (isExclusive(call.metadata)) {
      segments.push({ _tag: "exclusive", call })
      continue
    }
    if (last?._tag === "parallel") last.calls.push(call)
    else segments.push({ _tag: "parallel", calls: [call] })
  }
  return segments
}

export const mayStart = (opts: {
  readonly call: ScheduledCall
  readonly recorded: ReadonlyArray<ScheduledCall>
  readonly settled: ReadonlySet<string>
  readonly active: ReadonlySet<string>
  readonly maxConcurrency: number
}): boolean => {
  const before = opts.recorded.slice(0, opts.recorded.indexOf(opts.call))
  const isExclusiveCall = isExclusive(opts.call.metadata)
  if (isExclusiveCall) return before.every((c) => opts.settled.has(c.id))
  const parallelActive = Array.from(opts.active).filter((id) => {
    const c = opts.recorded.find((r) => r.id === id)
    return c !== undefined && !isExclusive(c.metadata)
  }).length
  return (
    before.every((c) => !isStateChanging(c.metadata) || opts.settled.has(c.id)) &&
    !Array.from(opts.active).some((id) => {
      const c = opts.recorded.find((r) => r.id === id)
      return c !== undefined && isStateChanging(c.metadata)
    }) &&
    parallelActive < opts.maxConcurrency
  )
}
```

- [ ] **Step 4: Add the metadata accessor** — in `tool.ts` export `ScheduleMetadata` (interface with the two booleans). In `registry.ts` add to `Materialization`:

```ts
readonly metadata: (name: string) => Tool.ScheduleMetadata | undefined
```

and in the `materialize` return object:

```ts
metadata: (name) => {
  const registration = selected.get(name)
  if (!registration) return undefined
  return { stateChanging: registration.tool.stateChanging, concurrencySafe: registration.tool.concurrencySafe }
},
```

(Import `ScheduleMetadata` type from `./tool` as needed.)

- [ ] **Step 5: Run test, watch it pass** — same command as Step 2. Then `cd packages/core && bun typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tool/schedule.ts packages/core/src/tool/tool.ts packages/core/src/tool/registry.ts packages/core/test/tool-schedule.test.ts
git commit -m "feat(core): pure scheduling decider over tool call metadata"
```

---

### Task 3: Bounded concurrency execution in the runner region

**Files:**
- Create: `packages/core/src/config/tools.ts`
- Modify: `packages/core/src/config.ts` (add `tools` to `Info`)
- Create: `packages/core/src/session/runner/settlement.ts`
- Modify: `packages/core/src/session/runner/llm.ts` (settlement region ~243–282 and the fiber-await region ~306–321)
- Test: `packages/core/test/session-runner-scheduler.test.ts`

**Interfaces:**
- Consumes: `plan`/`mayStart`/`ScheduledCall` (Task 2); `ToolRegistry.Settlement`/`ToolOutputStore.Error`; `publisher.publish`/`failUnsettledTools` (publish-llm-event.ts); `Config.Info.tools`.
- Produces:
  - `packages/core/src/config/tools.ts`:
    ```ts
    export * as ConfigTools from "./tools"
    import { Schema } from "effect"
    export class Info extends Schema.Class<Info>("Config.Tools.Info")({
      maxConcurrency: Schema.Number.pipe(Schema.optional).annotate({
        description: "Maximum concurrently-executing concurrency-safe tool calls within one provider turn (default 8)",
      }),
    }) {}
    ```
    and `Config.Info` gains `tools: ConfigTools.Info.pipe(Schema.optional)` (mirror `tool_output` at `config.ts:84-86`).
  - `packages/core/src/session/runner/settlement.ts`:
    ```ts
    export interface RunItem {
      readonly call: ScheduledCall
      readonly run: Effect.Effect<ToolRegistry.Settlement, ToolOutputStore.Error>
      readonly onSettled: (settlement: ToolRegistry.Settlement) => Effect.Effect<void>
      readonly onAborted: (message: string) => Effect.Effect<void>
    }
    export interface SettlementExecutor {
      readonly record: (item: RunItem) => Effect.Effect<void>
      readonly join: () => Effect.Effect<void>
      readonly clear: () => Effect.Effect<void>
    }
    export const makeSettlementExecutor: (opts: {
      readonly maxConcurrency: number
      readonly plan: (calls: ReadonlyArray<ScheduledCall>) => RunPlan
      readonly mayStart: typeof mayStart
    }) => Effect.Effect<SettlementExecutor, never, Scope.Scope>
    ```
    (inject `plan`/`mayStart` for unit tests; the runner passes the real ones).

- [ ] **Step 1: Write the failing config + executor tests** — `test/session-runner-scheduler.test.ts`:

```ts
// packages/core/test/session-runner-scheduler.test.ts
import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { executions, gates, it, maxActiveControl, responses, setMaxConcurrency, setup, sessionID } from "./lib/streaming-runner"

it.effect("bounds parallel concurrency-safe execution to tools.maxConcurrency", () =>
  Effect.gen(function* () {
    yield* setup
    setMaxConcurrency(2)
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Bounded" }), resume: false })
    for (let i = 0; i < 6; i++) gates.set(`call-${i}`, yield* Deferred.make())
    responses = [
      [
        LLMEvent.stepStart({ index: 0 }),
        ...Array.from({ length: 6 }, (_, i) => LLMEvent.toolCall({ id: `call-${i}`, name: "echo", input: { text: `${i}` } })),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ],
      [],
    ]
    const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
    while (executions.length < 2) yield* Effect.yieldNow
    yield* Effect.yieldNow
    expect(maxActiveControl()).toBeLessThanOrEqual(2)   // never exceeds the bound
    expect(executions).toHaveLength(2)                  // third waits for a slot
    for (let i = 0; i < 6; i++) yield* Deferred.succeed(gates.get(`call-${i}`)!, undefined)
    yield* Fiber.join(run)
    expect(executions).toHaveLength(6)
  }),
)

it.effect("never overlaps stateChanging tools and runs them in recorded order", () =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Exclusive" }), resume: false })
    const r0 = yield* Deferred.make<void>()
    const w1 = yield* Deferred.make<void>()
    const r1 = yield* Deferred.make<void>()
    const w2 = yield* Deferred.make<void>()
    for (const [id, gate] of [["r0", r0], ["w1", w1], ["r1", r1], ["w2", w2]] as const) gates.set(id, gate)
    responses = [
      [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "r0", name: "echo", input: { text: "r0" } }),
        LLMEvent.toolCall({ id: "w1", name: "stateful", input: { text: "w1" } }),
        LLMEvent.toolCall({ id: "r1", name: "echo", input: { text: "r1" } }),
        LLMEvent.toolCall({ id: "w2", name: "stateful", input: { text: "w2" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ],
      [],
    ]
    const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
    while (!executions.includes("r0")) yield* Effect.yieldNow
    expect(executions.filter((id) => id === "w1" || id === "r1" || id === "w2")).toHaveLength(0)  // w1 waits for r0; r1/w2 wait for w1
    yield* Deferred.succeed(r0, undefined)
    while (!executions.includes("w1")) yield* Effect.yieldNow
    expect(executions.filter((id) => id === "r1" || id === "w2")).toHaveLength(0)  // w1 is exclusive
    yield* Deferred.succeed(w1, undefined)
    while (!executions.includes("r1")) yield* Effect.yieldNow
    expect(executions.filter((id) => id === "w2")).toHaveLength(0)  // r1 runs before w2 (recorded order)
    yield* Deferred.succeed(r1, undefined)
    while (!executions.includes("w2")) yield* Effect.yieldNow
    yield* Deferred.succeed(w2, undefined)
    yield* Fiber.join(run)
    expect(executions).toEqual(["r0", "w1", "r1", "w2"])
  }),
)
```

Also add to the harness: `setMaxConcurrency(n)` sets the module-level `maxConcurrency` AND rebuilds the config layer effect (read it lazily inside `entries` so the bound is picked up per test), and `maxActiveControl()` returns `maxActive`. If the config layer is built once, read `maxConcurrency` inside the `entries` closure (module-level variable) so rebinding works without rebuilding the layer.

- [ ] **Step 2: Run, watch fail** — `cd packages/core && bun test test/session-runner-scheduler.test.ts` → `Config.Tools`/`SettlementExecutor` missing; also the runner currently starts all tools eagerly (first test fails: `executions` length 6, not 2).

- [ ] **Step 3: Implement the config module** — `src/config/tools.ts` (interface above), wire `tools` into `Config.Info`, then `cd packages/core && bun typecheck`.

- [ ] **Step 4: Implement the executor** — `src/session/runner/settlement.ts`:

```ts
import { Effect, FiberSet, Semaphore, Scope } from "effect"
import { mayStart, plan, type RunPlan, type ScheduledCall } from "../../tool/schedule"
import type { ToolOutputStore } from "../../tool-output-store"
import type { ToolRegistry } from "../../tool/registry"

export interface RunItem { readonly call: ScheduledCall; readonly run: Effect.Effect<ToolRegistry.Settlement, ToolOutputStore.Error>; readonly onSettled: (settlement: ToolRegistry.Settlement) => Effect.Effect<void>; readonly onAborted: (message: string) => Effect.Effect<void> }
export interface SettlementExecutor { readonly record: (item: RunItem) => Effect.Effect<void>; readonly join: () => Effect.Effect<void>; readonly clear: () => Effect.Effect<void> }

export const makeSettlementExecutor = (opts: {
  readonly maxConcurrency: number
  readonly plan: (calls: ReadonlyArray<ScheduledCall>) => RunPlan
  readonly mayStart: typeof mayStart
}) =>
  Effect.gen(function* () {
    const fibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
    const bookkeeping = yield* Semaphore.make(1)
    const items = new Map<string, RunItem>()
    const recorded: ScheduledCall[] = []
    const settled = new Set<string>()
    const active = new Set<string>()
    let aborted = false
    let abortMessage = "aborted after sibling failure"

    const dispatch = (item: RunItem) =>
      Effect.gen(function* () {
        active.add(item.call.id)
        yield* Effect.uninterruptibleMask((restore) =>
          restore(item.run).pipe(
            Effect.flatMap((settlement) => item.onSettled(settlement)),
            Effect.catchAllCause((cause) => {
              if (aborted && !settled.has(item.call.id)) return item.onAborted(abortMessage)
              return Effect.failCause(cause)
            }),
          ),
        ).pipe(
          Effect.ensuring(
            bookkeeping.withPermit(
              Effect.gen(function* () {
                active.delete(item.call.id)
                settled.add(item.call.id)
                yield* tryDispatch()
              }),
            ),
          ),
          Effect.tapErrorCause(() => Effect.sync(() => settled.add(item.call.id))),
          Effect.asVoid,
        ).pipe(FiberSet.run(fibers))
      })

    const tryDispatch = Effect.gen(function* () {
      for (const item of recorded) {
        if (settled.has(item.call.id) || active.has(item.call.id)) continue
        if (!opts.mayStart({ call: item.call, recorded, settled, active, maxConcurrency: opts.maxConcurrency })) continue
        yield* dispatch(item)
      }
    })

    return SettlementExecutor.of({
      record: (item) =>
        bookkeeping.withPermit(
          Effect.gen(function* () {
            items.set(item.call.id, item)
            recorded.push(item.call)
            yield* tryDispatch()
          }),
        ),
      join: () => Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers)),
      clear: () => Effect.gen(function* () { yield* FiberSet.clear(fibers) }),
    })
  })
```

Notes for the implementer: `bookkeeping.withPermit` serializes all decision state (record/dispatch/completion) so `mayStart` decisions are race-free. Task 3 does NOT trigger sibling-abort yet (`aborted` stays false; `catchAllCause` rethrows). Task 4 sets `aborted`/abort message from the completion handler. If `Semaphore` lacks a `.withPermit` Effect-compatible form in this Effect version, use the pattern already in `llm.ts:237` (`Semaphore.makeUnsafe(1).withPermit`). Real code wins over this excerpt; the observable contract is what the tests assert.

- [ ] **Step 5: Wire the runner** — in `llm.ts`:

Replace the tool-call dispatch block (lines ~260–282) so that after `publish(event)` (durable record, keep as-is) and the `toolMaterialization` guard, the call is recorded through the executor instead of `FiberSet.run`:

```ts
const schedule = (event: LLMEvent, assistantMessageID: SessionMessage.ID) =>
  Effect.gen(function* () {
    const metadata = toolMaterialization.metadata(event.name) ?? { stateChanging: false, concurrencySafe: false }
    yield* executor.record({
      call: { id: event.id, name: event.name, metadata },
      run: Effect.uninterruptibleMask((restore) =>
        restore(
          toolMaterialization.settle({ sessionID: session.id, agent: agent.id, assistantMessageID, call: event }),
        ),
      ),
      onSettled: (settlement) =>
        withPublication(
          publish(
            LLMEvent.toolResult({ id: event.id, name: event.name, result: settlement.result, output: settlement.output }),
            settlement.outputPaths ?? [],
          ),
        ),
      onAborted: (message) => withPublication(publisher.failTool(event.id, message)),
    })
  })
```

Create the executor once per turn next to the `toolFibers` line (~line 192):

```ts
const entries = yield* config.entries()
const maxConcurrency = Config.latest(entries, "tools")?.maxConcurrency ?? 8
const executor = yield* makeSettlementExecutor({
  maxConcurrency,
  plan,
  mayStart,
}).pipe(Effect.ensuring(Effect.void))  // executor owns its fiber scope
```

Then:
- replace the call site `...FiberSet.run(toolFibers)` with `yield* schedule(event)` plus `needsContinuation = true` (kept).
- delete the `toolFibers` FiberSet; replace `awaitToolFibers(toolFibers)` (line ~307) with `executor.join()` and `FiberSet.clear(toolFibers)` (lines ~306, 309, 317) with `executor.clear()`.
- add `publisher.failTool(callID, message)` to `publish-llm-event.ts` (single-call durable failure; mirrors `failUnsettledTools` for one call, marks `settled`, publishes `SessionEvent.Tool.Failed`).

- [ ] **Step 6: Run both suites, watch them pass** — `bun test test/session-runner-scheduler.test.ts test/session-runner-streaming.test.ts`. Then `bun typecheck`. The Task 1 characterization tests MUST still pass (record order + interrupt unchanged).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/config/tools.ts packages/core/src/config.ts packages/core/src/session/runner/settlement.ts packages/core/src/session/runner/llm.ts packages/core/src/session/runner/publish-llm-event.ts packages/core/test/session-runner-scheduler.test.ts packages/core/test/lib/streaming-runner.ts
git commit -m "feat(core): bounded-concurrency tool settlement in the runner"
```

---

### Task 4: Sibling-abort semantics

**Files:**
- Modify: `packages/core/src/session/runner/settlement.ts` (set `aborted`/`abortMessage` on stateChanging failure; abort pending concurrencySafe siblings)
- Test: `packages/core/test/session-runner-sibling-abort.test.ts`

**Interfaces:**
- Consumes: `RunItem.call.metadata`; `SettlementExecutor` (Task 3).
- Produces: behavior contract — when a `stateChanging` call's settlement is a failure (`settlement.result.type === "error"`), every concurrencySafe call recorded after it that is not yet settled is durably failed with `aborted after sibling failure`; in-flight siblings are interrupted, queued siblings never start; non-concurrencySafe calls recorded after it proceed; non-stateChanging failures abort nothing.

- [ ] **Step 1: Write the failing test** — `test/session-runner-sibling-abort.test.ts`:

```ts
// packages/core/test/session-runner-sibling-abort.test.ts
import { expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { durableToolEvents, executions, gates, it, responses, setup, sessionID } from "./lib/streaming-runner"

it.effect("durably fails pending concurrencySafe siblings when a stateChanging tool fails", () =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Sibling abort" }), resume: false })
    // register a failing stateChanging tool through the harness
    const failing = yield* registerFailingStateChanging()   // harness helper: tool named "failing_state" whose execute returns new Tool.Failure({ message: "boom" })
    responses = [
      [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "w-fail", name: "failing_state", input: { text: "w" } }),
        LLMEvent.toolCall({ id: "r1", name: "echo", input: { text: "r1" } }),
        LLMEvent.toolCall({ id: "r2", name: "echo", input: { text: "r2" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ],
      [],
    ]
    const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
    yield* Fiber.join(run)

    const events = yield* durableToolEvents(sessionID)
    const failed = events.filter((e) => e.type === "session.next.tool.failed.1")
    const messages = failed.map((e) => (e.data as { callID: string; error: { message: string } }))
    const aborted = messages.filter((m) => m.error.message === "aborted after sibling failure").map((m) => m.callID)
    expect(aborted.sort()).toEqual(["r1", "r2"])
    expect(executions.filter((id) => id === "r1" || id === "r2")).toHaveLength(0) // queued siblings never started
    expect(events.filter((e) => e.type === "session.next.tool.success.1")).toHaveLength(0)
  }),
)

it.effect("siblings recorded before a failing stateChanging call already settled and are not aborted", () =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Prior siblings settle" }), resume: false })
    gates.set("r0", yield* Deferred.make())   // parallel sibling recorded BEFORE the failing stateChanging call
    responses = [
      [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "r0", name: "echo", input: { text: "r0" } }),
        LLMEvent.toolCall({ id: "w-fail", name: "failing_state", input: { text: "w" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ],
      [],
    ]
    const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
    while (!executions.includes("r0")) yield* Effect.yieldNow
    yield* Deferred.succeed(gates.get("r0")!, undefined)
    yield* Fiber.join(run)   // w-fail waits for r0, then fails; r0 is settled, never aborted

    const events = yield* durableToolEvents(sessionID)
    expect(events.some((e) => e.type === "session.next.tool.success.1" && (e.data as { callID: string }).callID === "r0")).toBe(true)
    const r0Failed = events.filter((e) => e.type === "session.next.tool.failed.1" && (e.data as { callID: string }).callID === "r0")
    expect(r0Failed).toHaveLength(0)
  }),
)

it.effect("a non-stateChanging failure does not abort siblings", () =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "No abort" }), resume: false })
    responses = [
      [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "r-fail", name: "failing_echo", input: { text: "r" } }),
        LLMEvent.toolCall({ id: "r1", name: "echo", input: { text: "r1" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ],
      [],
    ]
    const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
    yield* Fiber.join(run)
    const events = yield* durableToolEvents(sessionID)
    const failed = events.filter((e) => e.type === "session.next.tool.failed.1")
    expect(failed.map((e) => (e.data as { callID: string }).callID)).toEqual(["r-fail"])
    expect(failed.every((e) => (e.data as { error: { message: string } }).error.message !== "aborted after sibling failure")).toBe(true)
    expect(events.some((e) => e.type === "session.next.tool.success.1" && (e.data as { callID: string }).callID === "r1")).toBe(true)
  }),
)
```

Add harness helpers: `registerFailingStateChanging()` registers `failing_state` (stateChanging, execute returns `new Tool.Failure({ message: "boom" })`) and `failing_echo` (concurrencySafe, same failure). Note the second test's comment: under this schedule a concurrencySafe call recorded *after* a stateChanging call can never start before that stateChanging settles, so "in-flight sibling recorded after the failing call" is structurally unreachable — the executor's `catchAllCause` sibling-abort branch exists defensively for same-segment races and for forward compatibility, and is not asserted as reachable. Keep the assertion trivial and documented; do not weaken the first and third tests.

- [ ] **Step 2: Run, watch the sibling-abort tests fail** — `cd packages/core && bun test test/session-runner-sibling-abort.test.ts`. First test fails (siblings complete, no `aborted after sibling failure`).

- [ ] **Step 3: Implement sibling-abort** — in `settlement.ts`, capture failure results in the dispatch fiber. Change the completion effect so that when `settlement.result.type === "error"` and the settled call is `stateChanging`, it sets `aborted = true` / `abortMessage = "aborted after sibling failure"` and fails every pending concurrencySafe sibling:

```ts
const onSettledWithAbort = (item: RunItem, settlement: ToolRegistry.Settlement) =>
  Effect.gen(function* () {
    yield* item.onSettled(settlement)
    if (!isStateChanging(item.call.metadata) || settlement.result.type !== "error") return
    aborted = true
    for (const sibling of recorded) {
      if (sibling.id === item.call.id || settled.has(sibling.id)) continue
      if (!sibling.metadata.concurrencySafe || sibling.metadata.stateChanging) continue
      if (active.has(sibling.id)) {
        // in-flight sibling: its fiber's catchAllCause sees `aborted` and publishes onAborted
        continue
      }
      settled.add(sibling.id)
      const pending = items.get(sibling.id)
      if (pending) yield* pending.onAborted(abortMessage)
    }
  })
```

Use `onSettledWithAbort` in place of `item.onSettled` inside `dispatch`. Keep the `catchAllCause` sibling branch (it converts an interrupted in-flight sibling into a durable `onAborted`; under the current schedule that branch is structurally unreachable because a stateChanging call never overlaps any sibling, so treat it as defensive/forward-compatible — do not assert it in tests). Import `isStateChanging` from `../../tool/schedule`.

- [ ] **Step 4: Run, watch pass; then Task 1 + Task 3 suites** — `bun test test/session-runner-sibling-abort.test.ts test/session-runner-scheduler.test.ts test/session-runner-streaming.test.ts`. Then `bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/runner/settlement.ts packages/core/test/session-runner-sibling-abort.test.ts packages/core/test/lib/streaming-runner.ts
git commit -m "feat(core): abort pending concurrency-safe siblings on state-changing failure"
```

---

### Task 5: Speculative permission evaluation cached by call id

**Files:**
- Create: `packages/core/src/permission/speculative.ts`
- Modify: `packages/core/src/permission.ts` (seam accommodations: request-id derivation from `source.callID`; `resolved` outcome cache consulted before re-asking; recorded in `reply` and on `assert` resolution)
- Modify: `packages/core/src/tool/tool.ts` (optional `preflight` on `Config` + runtime + accessor)
- Modify: `packages/core/src/tool/registry.ts` (`Materialization.preflight`)
- Modify: `packages/core/src/tool/bash.ts` (wire `preflight` for the primary command assert)
- Modify: `packages/core/src/session/runner/llm.ts` (start preflight at call-record time; await verdict before dispatch)
- Test: `packages/core/test/permission-speculative.test.ts` (+ runner integration test)

**Interfaces:**
- Consumes: `PermissionV2.Service` (`ask`/`assert`/`reply`, `AssertInput`, `BlockedError`/`CorrectedError`/`DeclinedError`); RUN-06 `ApprovalPipeline` documented seam (`TODO/README.md` §7 — RUN-08 implements timing against the current `PermissionV2` surface and documents the seam contract; RUN-06 must keep one verdict per request id).
- Produces:
  - `packages/core/src/permission/speculative.ts`:
    ```ts
    export interface SpeculativeEvaluation {
      readonly awaitVerdict: () => Effect.Effect<void, Tool.Failure>
    }
    export interface Interface {
      readonly start: (callID: string, evaluate: () => Effect.Effect<void, Tool.Failure>) => Effect.Effect<SpeculativeEvaluation>
    }
    export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SpeculativeEvaluation") {}
    ```
    Contract: `start` forks `evaluate()` immediately (call-record time), dedupes by `callID` (repeat `start` returns the cached handle), and the handle's `awaitVerdict` joins the fork. Turn-scoped (cleared by a scope finalizer).
  - `tool.ts`: `readonly preflight?: (input: Schema.Schema.Type<Input>, context: Context) => Effect.Effect<void, ToolFailure>` on `Config`; runtime default `() => Effect.void`; accessor `Tool.preflight(tool, input, context)`.
  - `registry.ts` `Materialization`: `readonly preflight: (input: ExecuteInput) => Effect.Effect<void, Tool.Failure>` — decodes input exactly like `settleWith`, runs `Tool.preflight(registration.tool, input, context)`.
  - `permission.ts` seam: `assert`/`ask` derive the request id from `input.source.callID` when `input.id` is absent; `assert` consults a `resolved` cache keyed by request id before re-creating an ask; `reply` and `assert`-resolution record outcomes into `resolved`. Exact names: `const requestID = (input: AssertInput): ID => input.id ?? (input.source?.type === "tool" ? input.source.callID : undefined) ?? ID.create()` and `const resolved = new Map<ID, { readonly ok: true } | { readonly ok: false; readonly error: DeclinedError | CorrectedError }>()`.

- [ ] **Step 1: Write the failing unit tests** — `test/permission-speculative.test.ts` (build the real `PermissionV2.locationLayer` as `permission.test.ts` does; do not mock the service):

```ts
// packages/core/test/permission-speculative.test.ts
import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Scope } from "effect"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SpeculativeEvaluation } from "@opencode-ai/core/permission/speculative"
import { Tool } from "@opencode-ai/core/tool/tool"
import { testEffect } from "./lib/effect"

const it = testEffect(/* layer with PermissionV2.locationLayer + SpeculativeEvaluation.node */)

const toolSource = (callID: string): PermissionV2.Source => ({ type: "tool", messageID: "msg_spec", callID })
const asToolFailure = (e: PermissionV2.BlockedError | PermissionV2.CorrectedError) =>
  new Tool.Failure({ message: e instanceof PermissionV2.BlockedError ? "blocked" : "corrected" })

it.effect("begins evaluation at call-record time, cached by call id", () =>
  Effect.gen(function* () {
    const started: string[] = []
    const speculative = yield* SpeculativeEvaluation.Service
    const first = yield* speculative.start("call-1", () =>
      Effect.sync(() => started.push("call-1")).pipe(Effect.mapError(() => new Tool.Failure({ message: "x" }))),
    )
    const second = yield* speculative.start("call-1", () => Effect.void)
    expect(second).toBe(first)
    expect(started).toEqual(["call-1"])
    yield* first.awaitVerdict()
  }),
)

it.effect("awaitVerdict fails with the evaluate failure", () =>
  Effect.gen(function* () {
    const speculative = yield* SpeculativeEvaluation.Service
    const handle = yield* speculative.start("call-2", () => Effect.fail(new Tool.Failure({ message: "denied" })))
    const exit = yield* handle.awaitVerdict().pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)

it.effect("a policy-allow verdict resolves awaitVerdict without any pending request", () =>
  Effect.gen(function* () {
    const permission = yield* PermissionV2.Service
    const speculative = yield* SpeculativeEvaluation.Service
    // ruleset allows bash on this resource, so assert never creates a pending ask
    const handle = yield* speculative.start("call-allow", () =>
      permission.assert({
        id: "call-allow",
        action: "bash",
        resources: ["echo hi"],
        sessionID: "ses_spec",
        source: toolSource("call-allow"),
      }).pipe(Effect.mapError(asToolFailure)),
    )
    yield* handle.awaitVerdict()
    expect(yield* permission.list()).toHaveLength(0)
  }),
)

it.effect("an ask verdict is created at record time and one reply resolves both the preflight and the leaf assert", () =>
  Effect.gen(function* () {
    const permission = yield* PermissionV2.Service
    const speculative = yield* SpeculativeEvaluation.Service
    // default ruleset asks: preflight forks an assert keyed by the call id
    const handle = yield* speculative.start("call-ask", () =>
      permission.assert({
        id: "call-ask",
        action: "bash",
        resources: ["rm -rf /tmp/x"],
        save: ["rm -rf /tmp/x"],
        sessionID: "ses_spec",
        source: toolSource("call-ask"),
      }).pipe(Effect.mapError(asToolFailure)),
    )
    const pending = yield* permission.list()
    expect(pending.some((p) => p.id === "call-ask")).toBe(true)  // evaluation started at record time
    yield* permission.reply({ requestID: "call-ask", reply: "once" })
    yield* handle.awaitVerdict()
    // leaf-time re-assert with the SAME call id must not create a second prompt
    yield* permission.assert({
      action: "bash",
      resources: ["rm -rf /tmp/x"],
      save: ["rm -rf /tmp/x"],
      sessionID: "ses_spec",
      source: toolSource("call-ask"),   // no explicit id -> derives callID
    }).pipe(Effect.mapError(asToolFailure))
    expect(yield* permission.list()).toHaveLength(0)
  }),
)
```

Adjust the layer build to the real `permission.test.ts` harness (see that file for exact layer construction, including `PermissionSaved` and session setup). The third test's allow-policy setup: follow `permission.test.ts` for a configured ruleset that allows `bash` on `echo hi`. The fourth test asserts the seam accommodations: `requestID` derivation from `source.callID` and the `resolved` cache (leaf re-assert resolves without a new pending).

- [ ] **Step 2: Run, watch fail** — `cd packages/core && bun test test/permission-speculative.test.ts` → module missing.

- [ ] **Step 3: Implement `speculative.ts`** — as specified: `Service` holds `Map<callID, { deferred: Deferred<...>; handle }>`; `start` dedupes, forks `evaluate()`, returns a handle whose `awaitVerdict` joins. Use a scope finalizer to clear the map. Turn-scoped by construction (the runner creates it per provider turn).

- [ ] **Step 4: Add the `preflight` seam** — `tool.ts` `Config.preflight` + runtime + `Tool.preflight` accessor; `registry.ts` `Materialization.preflight` (decode input, run preflight, map decode errors to `ToolFailure` like `settleWith` does).

- [ ] **Step 5: Make `permission.ts` seam accommodations** — implement `requestID`, the `resolved` map, record on `reply` (both branches) and on `assert` resolution, consult `resolved` in `assert`'s ask branch before `create`. Keep `create`'s duplicate-id guard unchanged (RUN-06 may relax it; RUN-08 does not need to because the runner awaits the verdict before dispatch, so leaf-time re-entry never races the preflight pending).

- [ ] **Step 6: Wire bash + the runner** — in `bash.ts`, add to the `Tool.make` config:

```ts
preflight: (input, context) =>
  permission.assert({
    id: context.toolCallID,
    action: name,
    resources: [input.command],
    save: [input.command],
    sessionID: context.sessionID,
    agent: context.agent,
    source: { type: "tool" as const, messageID: context.assistantMessageID, callID: context.toolCallID },
  }).pipe(Effect.mapError((error) => new Tool.Failure({ message: error instanceof PermissionV2.BlockedError ? "Blocked" : "Corrected" }))),
```

In `llm.ts`, in the tool-call handler after `publish(event)`, before `executor.record`:

```ts
const speculative = Option.getOrUndefined(yield* Effect.serviceOption(SpeculativeEvaluation.Service))
const preflight = speculative
  ? yield* speculative.start(event.id, () => toolMaterialization.preflight({ sessionID: session.id, agent: agent.id, assistantMessageID, call: event }))
  : undefined
```

and in the `RunItem.run` closure, await the verdict first:

```ts
run: Effect.uninterruptibleMask((restore) =>
  (preflight ? preflight.awaitVerdict() : Effect.void).pipe(
    Effect.flatMap(() => restore(toolMaterialization.settle({ ... }))),
  ),
),
```

The runner reads the speculative service optionally (`Effect.serviceOption`), so existing harnesses that do not provide it are unaffected.

- [ ] **Step 7: Runner integration test** — add to `test/permission-speculative.test.ts` (or `session-runner-speculative.test.ts`) a full-runner test using the `streaming-runner` harness plus a real `PermissionV2.locationLayer` and a `SpeculativeEvaluation` layer: stream two `bash` calls with an "ask" policy; assert `Event.Asked` (a pending request) exists BEFORE the stream closes (evaluation started at call-record time), then reply `once`; assert the settle completed and exactly ONE `session.next.tool.called.1`/`success` pair per call with no second prompt (`permission.list()` returns no duplicate `call-*` pendings).

- [ ] **Step 8: Run the full task suite** — `bun test test/permission-speculative.test.ts test/session-runner-streaming.test.ts test/session-runner-scheduler.test.ts test/session-runner-sibling-abort.test.ts`. Then `bun typecheck`.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/permission/speculative.ts packages/core/src/permission.ts packages/core/src/tool/tool.ts packages/core/src/tool/registry.ts packages/core/src/tool/bash.ts packages/core/src/session/runner/llm.ts packages/core/test/permission-speculative.test.ts
git commit -m "feat(core): speculative permission evaluation cached by call id"
```

---

### Task 6: Bounded delta coalescing buffer

**Files:**
- Create: `packages/core/src/session/runner/delta-buffer.ts`
- Modify: `packages/core/src/session/runner/publish-llm-event.ts` (route `text-delta`/`reasoning-delta`/`tool-input-delta` through the buffer; flush before fragment end and at step-finish flush)
- Test: `packages/core/test/delta-buffer.test.ts`

**Interfaces:**
- Consumes: `SessionEvent.Text.Delta`/`Reasoning.Delta`/`Tool.Input.Delta` definitions; the publisher's `events.publish`.
- Produces:
  - `packages/core/src/session/runner/delta-buffer.ts`:
    ```ts
    export interface DeltaBuffer<E> {
      readonly push: (entry: E) => Effect.Effect<void>
      readonly flush: () => Effect.Effect<void>
    }
    export const makeDeltaBuffer: <E>(opts: {
      readonly publish: (batch: ReadonlyArray<E>) => Effect.Effect<void>
      readonly maxEvents?: number      // default 64
      readonly maxBytes?: number       // default 16 * 1024
    }) => DeltaBuffer<E>
    ```
    Contract: order-preserving single queue; `push` flushes when the count or byte bound is reached; `flush` is a no-op on an empty buffer. Generic over the entry type; the publisher supplies its own entry shape (e.g. `{ definition, data }`).

- [ ] **Step 1: Write the failing test** — `test/delta-buffer.test.ts`:

```ts
// packages/core/test/delta-buffer.test.ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeDeltaBuffer, type DeltaBuffer } from "../src/session/runner/delta-buffer"

type Entry = { readonly id: string; readonly delta: string }

const collect = () => {
  const batches: Array<ReadonlyArray<Entry>> = []
  const buffer: DeltaBuffer<Entry> = makeDeltaBuffer({
    publish: (batch) => Effect.sync(() => batches.push(batch)),
    maxEvents: 3,
    maxBytes: 64,
  })
  return { batches, buffer }
}

test("flushes on the event-count bound and preserves order", async () => {
  const { batches, buffer } = collect()
  await Effect.runPromise(buffer.push({ id: "a", delta: "1" }))
  await Effect.runPromise(buffer.push({ id: "b", delta: "2" }))
  expect(batches).toHaveLength(0)
  await Effect.runPromise(buffer.push({ id: "c", delta: "3" }))
  expect(batches).toHaveLength(1)
  expect(batches[0]!.map((e) => e.id)).toEqual(["a", "b", "c"])
  await Effect.runPromise(buffer.flush())
  expect(batches).toHaveLength(1)  // empty flush is a no-op
})

test("flushes on the byte bound", async () => {
  const { batches, buffer } = collect()  // maxBytes 64
  await Effect.runPromise(buffer.push({ id: "a", delta: "x".repeat(40) }))
  await Effect.runPromise(buffer.push({ id: "b", delta: "x".repeat(40) }))
  expect(batches).toHaveLength(1)  // 40+40 >= 64
})

test("explicit flush emits the remainder exactly once, in order", async () => {
  const { batches, buffer } = collect()
  await Effect.runPromise(buffer.push({ id: "a", delta: "1" }))
  await Effect.runPromise(buffer.push({ id: "b", delta: "2" }))
  await Effect.runPromise(buffer.flush())
  await Effect.runPromise(buffer.flush())
  expect(batches).toHaveLength(1)
  expect(batches[0]!.map((e) => e.id)).toEqual(["a", "b"])
})
```

- [ ] **Step 2: Run, watch fail** — `cd packages/core && bun test test/delta-buffer.test.ts` → module missing.

- [ ] **Step 3: Implement the buffer** — `src/session/runner/delta-buffer.ts` (stateful, Effect-free aside from the injected `publish`; `let` is required for the buffer state):

```ts
import { Effect } from "effect"

export const makeDeltaBuffer = <E>(opts: {
  readonly publish: (batch: ReadonlyArray<E>) => Effect.Effect<void>
  readonly maxEvents?: number
  readonly maxBytes?: number
}): DeltaBuffer<E> => {
  const maxEvents = opts.maxEvents ?? 64
  const maxBytes = opts.maxBytes ?? 16 * 1024
  let pending: E[] = []
  let bytes = 0
  const flush = () => {
    if (pending.length === 0) return Effect.void
    const batch = pending
    pending = []
    bytes = 0
    return opts.publish(batch)
  }
  const push = (entry: E) => {
    pending.push(entry)
    bytes += JSON.stringify(entry).length
    return bytes >= maxBytes || pending.length >= maxEvents ? flush() : Effect.void
  }
  return { push, flush }
}
```

- [ ] **Step 4: Wire the publisher** — in `publish-llm-event.ts`, define a local entry type `type DeltaEntry = { definition: DeltaDefinition; data: EventV2.Payload<DeltaDefinition> }` for the three delta definitions, and construct a buffer with `publish: (batch) => Effect.forEach(batch, (e) => events.publish(e.definition, e.data), { discard: true })`. Route the three delta cases (`text-delta` ~line 255, `reasoning-delta` ~line 278, `tool-input-delta` ~line 300) through `buffer.push` instead of direct `events.publish`. Call `buffer.flush()`:
  - at the start of the `fragments(...).end` handlers (so the durable `Ended` always follows its deltas), and
  - in the step-finish `flush()` (~line 397) before `flushFragments()`.
  Keep the existing `Delta` events' payload shapes identical (coalescing only batches the `events.publish` calls; subscribers still receive the same per-delta events in the same order within a batch).

- [ ] **Step 5: Run the full suite** — `bun test test/delta-buffer.test.ts test/session-runner-tool-events.test.ts test/session-runner-streaming.test.ts`. Then `bun typecheck`. The tool-events test asserts delta/ended shapes; it must still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/session/runner/delta-buffer.ts packages/core/src/session/runner/publish-llm-event.ts packages/core/test/delta-buffer.test.ts
git commit -m "feat(core): bounded delta coalescing before projection writes"
```

---

### Task 7: Durable-order conformance under randomized interleavings

**Files:**
- Create: `packages/core/test/session-runner-order-invariant.test.ts`

**Interfaces:**
- Consumes: `streaming-runner` harness (Task 1), its config override + gates; `durableToolEvents`; `setMaxConcurrency`.
- Produces: a seeded property-style conformance test proving, across ≥64 seeds: (1) durable `Tool.Called` order == stream order; (2) every recorded local call has exactly one terminal durable event (Success or Failed); (3) `aborted after sibling failure` appears only on concurrencySafe calls recorded after a failing stateChanging call; (4) `maxActive ≤ maxConcurrency`.

- [ ] **Step 1: Write the failing property test**

```ts
// packages/core/test/session-runner-order-invariant.test.ts
import { expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { durableToolEvents, executions, gates, insertSession, it, maxActiveControl, responses, resetStreamingRunner, setMaxConcurrency, setup } from "./lib/streaming-runner"

// mulberry32 — deterministic, pure, seeded
const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

it.effect("keeps durable record order and terminal-event uniqueness under randomized interleavings", () =>
  Effect.gen(function* () {
    for (const seed of Array.from({ length: 64 }, (_, i) => i * 97 + 13)) {
      yield* resetStreamingRunner()
      yield* setup
      const rand = mulberry32(seed)
      const maxConcurrency = 1 + Math.floor(rand() * 8)
      setMaxConcurrency(maxConcurrency)
      const session = yield* SessionV2.Service
      const sessionID = SessionV2.ID.create()
      yield* insertSession(sessionID)  // fresh session per seed so durable events are isolated
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: `Seed ${seed}` }), resume: false })

      const count = 3 + Math.floor(rand() * 6)
      const calls = Array.from({ length: count }, (_, i) => {
        const roll = rand()
        const stateChanging = roll < 0.3
        const concurrencySafe = stateChanging ? false : roll < 0.9
        return { id: `c${i}`, name: stateChanging ? "stateful" : "echo", stateChanging, concurrencySafe }
      })
      const order = calls.map((c) => c.id)
      const gated = calls.filter((c) => rand() < 0.5)
      for (const c of gated) gates.set(c.id, yield* Deferred.make())
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          ...calls.map((c) => LLMEvent.toolCall({ id: c.id, name: c.name, input: { text: c.id } })),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      // release gates in a randomized order
      while (gated.length > 0) {
        yield* Effect.yieldNow
        const idx = Math.floor(rand() * gated.length)
        const call = gated.splice(idx, 1)[0]!
        yield* Deferred.succeed(gates.get(call.id)!, undefined)
      }
      yield* Fiber.join(run)

      const events = yield* durableToolEvents(sessionID)
      const called = events.filter((e) => e.type === "session.next.tool.called.1").map((e) => (e.data as { callID: string }).callID)
      expect(called).toEqual(order)  // invariant 1: durable record order == stream order

      const success = events.filter((e) => e.type === "session.next.tool.success.1")
      const failed = events.filter((e) => e.type === "session.next.tool.failed.1")
      for (const call of calls) {
        const terminals = success.filter((e) => (e.data as { callID: string }).callID === call.id).length +
          failed.filter((e) => (e.data as { callID: string }).callID === call.id).length
        expect(terminals).toBe(1)  // invariant 2: exactly one terminal durable event per recorded local call
      }

      const siblingFailures = failed.filter((e) => (e.data as { error: { message: string } }).error.message === "aborted after sibling failure").map((e) => (e.data as { callID: string }).callID)
      for (const id of siblingFailures) {
        const index = order.indexOf(id)
        const failingBefore = calls.slice(0, index).findLast((c) => c.stateChanging && failed.some((f) => (f.data as { callID: string }).callID === c.id))
        expect(failingBefore).toBeDefined()  // invariant 3: only concurrencySafe calls after a failing stateChanging call
        expect(calls[index]!.stateChanging).toBe(false)
      }
      expect(maxActiveControl()).toBeLessThanOrEqual(maxConcurrency)  // invariant 4
    }
  }),
)
```

Note: gates released in random order still respect the scheduler (a gated call may not start until `mayStart` permits); `Fiber.join(run)` completes once all tool fibers settle. If the stateChanging failure path never triggers in these seeds (because all stateChanging calls succeed), invariant 3 is vacuously true — acceptable; add a dedicated seed family (e.g., seeds where `roll < 0.3` and the failing_state tool is mixed in) by registering `failing_state` in the harness and including it when `rand() < 0.2`.

- [ ] **Step 2: Run, watch fail** — `cd packages/core && bun test test/session-runner-order-invariant.test.ts`. Under current code the first failure is expected if any seeded run trips an invariant; if the suite happens to pass (unbounded eager execution is still order-preserving and terminal-unique), force the point by temporarily asserting `maxActive ≤ 1` — it will fail on the eager unbounded scheduler. Revert to the real assertions after the fix (Task 3's bounded executor makes invariant 4 hold).

- [ ] **Step 3: Run against the completed scheduler** — with Tasks 1–6 landed, the property test must pass across all 64 seeds. `cd packages/core && bun typecheck`.

- [ ] **Step 4: Commit**

```bash
git add packages/core/test/session-runner-order-invariant.test.ts packages/core/test/lib/streaming-runner.ts
git commit -m "test(core): seeded conformance for durable-order invariance"
```

---

### Task 8: Specs, interface registry, provenance ledger

**Files:**
- Modify: `specs/v2/session.md` (Settlement passages: line ~50 and the "intentionally unbounded" passage ~line 173; add the durable-order invariant, bounded concurrency, sibling-abort, speculative preflight, delta coalescing)
- Modify: `TODO/README.md` (§7 Cross-Run Interface Registry — add the RUN-08 row)
- Create: `docs/provenance/sources.json`
- Create: `docs/provenance/ledger.json`
- Create: `docs/provenance/authorizations/run-08-streaming-tools.md`

**Interfaces:**
- Consumes: the produced interfaces from Tasks 2, 3, 5, 6 (names below).
- Produces: documentation + provenance entries. No code.

- [ ] **Step 1: Update `specs/v2/session.md`** — replace the "intentionally unbounded" sentence with: local tool execution is bounded by `tools.maxConcurrency` (default 8); concurrency-safe calls start as their inputs complete during the provider stream; state-changing calls never overlap and run in recorded order; a state-changing failure durably fails pending concurrency-safe siblings with `aborted after sibling failure`; durable record-before-effect ordering is preserved regardless of execution order; live-only deltas are coalesced by a bounded buffer and flushed at fragment boundaries. Add a Settlement subsection describing the speculative approval evaluation (evaluation starts at call-record time, verdict still awaited before side effects, cached per call id).

- [ ] **Step 2: Update `TODO/README.md` §7** — append rows:

| RUN-08 | `schedule.plan`/`schedule.mayStart` decider + `RunPlan`/`RunSegment` | `packages/core/src/tool/schedule.ts` | RUN-13 |
| RUN-08 | `SettlementExecutor` (bounded, exclusive serialization, sibling-abort) | `packages/core/src/session/runner/settlement.ts` | RUN-13 |
| RUN-08 | `SpeculativeEvaluation.Service` + `Tool.Config.preflight` + `Materialization.preflight` | `packages/core/src/permission/speculative.ts`, `packages/core/src/tool/{tool,registry}.ts` | RUN-13 |
| RUN-08 | `Config.Tools.Info.maxConcurrency` (default 8) | `packages/core/src/config/tools.ts` | RUN-13 |
| RUN-08 | `Materialization.metadata(name)` | `packages/core/src/tool/registry.ts` | RUN-13 |
| RUN-08 | `DeltaBuffer` | `packages/core/src/session/runner/delta-buffer.ts` | RUN-13 |

- [ ] **Step 3: Create provenance sources** — `docs/provenance/sources.json`:

```json
[
  {
    "id": "claude-code-2.1.88-restored",
    "repo_path": "../../claude-code-sourcemap",
    "remote_url": null,
    "branch": "restored",
    "pinned_commit": "a8a678cb6244e6770e1e421767ff0987a1d95549",
    "license_spdx": null,
    "license_file": null,
    "notice_file": null,
    "authorization_ref": "authorizations/run-08-streaming-tools.md",
    "history_available": true
  },
  {
    "id": "codex",
    "repo_path": "../../codex",
    "remote_url": null,
    "branch": "main",
    "pinned_commit": "0a0ebb85355113610dd3f7a3d8b36f68c33465fc",
    "license_spdx": "Apache-2.0",
    "license_file": "LICENSE",
    "notice_file": "NOTICE",
    "authorization_ref": null,
    "history_available": true
  }
]
```

Verify the `pinned_commit` values with `git -C ../claude-code-sourcemap rev-parse HEAD` and `git -C ../codex rev-parse HEAD` before writing; update if they moved. `repo_path` is relative to the repo root and must resolve (the validator checks existence).

- [ ] **Step 4: Create provenance ledger** — `docs/provenance/ledger.json`:

```json
{
  "version": 1,
  "imports": [
    {
      "id": "run-08-sibling-abort",
      "source_id": "claude-code-2.1.88-restored",
      "original_path": "src/services/tools/StreamingToolExecutor.ts",
      "destination": "packages/core/src/session/runner/settlement.ts",
      "treatment": "reimplement",
      "owner": "core",
      "imported_from_commit": "a8a678cb6244e6770e1e421767ff0987a1d95549",
      "license_spdx": null,
      "notice_required": false,
      "authorization_ref": "authorizations/run-08-streaming-tools.md",
      "imported_at": "2026-08-06",
      "local_modifications": ["Sibling abort fires on state-changing failure, not bash-only; message text differs; durable record-before-effect preserved"],
      "upstream_merge_owner": "core"
    },
    {
      "id": "run-08-speculative-classifier",
      "source_id": "claude-code-2.1.88-restored",
      "original_path": "src/tools/BashTool/bashPermissions.ts",
      "destination": "packages/core/src/permission/speculative.ts",
      "treatment": "reimplement",
      "owner": "core",
      "imported_from_commit": "a8a678cb6244e6770e1e421767ff0987a1d95549",
      "license_spdx": null,
      "notice_required": false,
      "authorization_ref": "authorizations/run-08-streaming-tools.md",
      "imported_at": "2026-08-06",
      "local_modifications": ["Evaluation cached per call id via PermissionV2 seam; no classifier; verdict awaited before side effects"],
      "upstream_merge_owner": "core"
    },
    {
      "id": "run-08-inline-parallel-dispatch",
      "source_id": "codex",
      "original_path": "core/src/session/turn.rs",
      "destination": "packages/core/src/session/runner/settlement.ts",
      "treatment": "reimplement",
      "owner": "core",
      "imported_from_commit": "0a0ebb85355113610dd3f7a3d8b36f68c33465fc",
      "license_spdx": "Apache-2.0",
      "notice_required": true,
      "authorization_ref": null,
      "imported_at": "2026-08-06",
      "local_modifications": ["FuturesOrdered -> bounded concurrency-safe executor with recorded-order exclusivity"],
      "upstream_merge_owner": "core"
    }
  ]
}
```

- [ ] **Step 5: Create the authorization file** — `docs/provenance/authorizations/run-08-streaming-tools.md`: a dated decision record authorizing idea-level reimplementation (never text port) of Claude Code 2.1.88 restored source for RUN-08, citing the files above, with the note that no Claude-derived text is copied and the CLAUDE-code authorization is confined to behavior described in the audit §16.

- [ ] **Step 6: Validate provenance + typecheck** — from repo root: `bun run scripts/provenance/validate.ts` (exit 0, `PROVENANCE OK`). Then `cd packages/core && bun typecheck`.

- [ ] **Step 7: Commit**

```bash
git add specs/v2/session.md TODO/README.md docs/provenance/sources.json docs/provenance/ledger.json docs/provenance/authorizations/run-08-streaming-tools.md
git commit -m "docs(core): settle specs, interface registry, and provenance for streaming tools"
```

---

## Run-Level Review Prompt (dispatch after Task 8)

```
Review the commits <list hashes> in /home/thymia/UltraCode-Planning/opencode
implementing RUN-08 (file: opencode/TODO/RUN-08-streaming-tools.md).
Run-specific checks:
1. Durable-order invariant: Tool.Called events are committed in provider-stream order,
   before any side effect, in every path — grep the diff for `publish(event)` relative to
   settlement dispatch. No reordering of the durable record.
2. One-owner rule: `ToolRegistry.Materialization.settle` is still the only executor;
   `settlement.ts` only decides when. No second registry/executor/authz callback was added.
3. Determinism: no `Date.now`, timers, or randomness in scheduling decisions in
   `packages/core/src/tool/schedule.ts` or `packages/core/src/session/runner/settlement.ts`.
   Randomness exists only in `session-runner-order-invariant.test.ts` (seeded PRNG).
4. Sibling-abort: fires only on a stateChanging failure; only pending concurrencySafe
   siblings; message is exactly `aborted after sibling failure`; durable and idempotent
   (never double-failed, never re-failed after settlement).
5. Interruption semantics unchanged: unsettled -> `Tool execution interrupted`; settled
   tools are never re-failed.
6. Permission seam: RUN-08 added no second approval pipeline; speculative evaluation is
   cached per call id and the final verdict is still awaited before side effects.
7. Diff scope: only files declared in the run plan.
Then the generic checks from TODO/README.md §5.1 items 1–5.
Reply numbered findings, BLOCKER or MINOR, file:line. No edits.
```

## Definition of Done

- [ ] Every task's Stage A gate passed (fresh verification by the orchestrator: commit exists, tests pass when you run them, typecheck passes, `git show --stat` touches only declared files).
- [ ] Run-level review verdict has no open BLOCKER findings.
- [ ] All items in the "Definition of Done" list under Orchestrator Brief are checked by commands you ran.
- [ ] `git status` clean; branch is `streaming-tools`.
- [ ] `bun typecheck` passes in `packages/core`.
- [ ] Run ledger (§8 of TODO/README.md) entry written with commit range and deviations.

## Deviation Log (fill during execution)

| Task | Deviation | Reason |
|---|---|---|
|  |  |  |
