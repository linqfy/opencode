# RUN-13: V2 Session Cutover — Parity Completion and Legacy Decommission

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every open V1 Runtime Context Parity row in `specs/v2/session.md`, implement `SessionV2` `shell/skill/compact/wait`, make the HTTP API serve V2 behind a default-off `experimental.v2Session` flag after a shadow-run conformance gate, migrate legacy data with lineage + token accounting, and then delete the legacy V1 session loop (`prompt.ts`, `processor.ts` + dependent plumbing) so exactly one session engine remains.

**Architecture:** Three phases. (1) **Parity** (Tasks 1–3): one burndown test per row of the V1 Runtime Context Parity checklist, then close the gaps as V2-native modules — `@ultracode/context` provider-family blocks, a `core/reminders` System Context advisory source, a narrow plugin system-transform seam, structured-output policy, `@`-mention/reference expansion before durable admission, configured-instruction sources, and `SessionV2.shell/skill/compact/wait` over existing primitives. (2) **Cutover gate** (Tasks 4–7): a Task 0 journal decision written down in `docs/architecture/v2-journal-cutover.md`, its chosen option implemented, a shadow-run harness comparing durable outcomes on a fixture corpus, data migration preserving lineage/admission/token-accounting semantics, then the HTTP handlers flipped behind `experimental.v2Session` (default OFF for one release). (3) **Decommission** (Tasks 8–10): delete the legacy loop, stop dual `message/part` projection, archive those tables, replay conformance cassettes, and update AGENTS.md + specs to mark parity 100% with exactly one session engine. Every task is TDD with real `bun:test` code.

**Tech Stack:** Bun, TypeScript, Effect-TS (v4 beta), Drizzle/SQLite (EventV2), `@ultracode/context` (prompt compiler), `@opencode-ai/schema` (durable-event manifests, session-input schema), Rust (cargo, `crates/ultracode-events` sidecar), `@opencode-ai/http-recorder` (cassette replay).

**Audit basis:** §2.2 (three session generations live), §5.1 (completion risk dominates), §6 T1 (dual projectors), §18-A2 (collapse to one session engine + dated V1 sunset; sidecar becomes *the* journal), §22 (V1 freeze is in effect; this run ends it), §23 P0 item 3 (parity burndown as the only session-track work queue), §26 risk 1 (behavioral drift; mitigate with shadow-run + conformance fixtures), §27.2 (one journal law).

## Global Constraints

All constraints in `TODO/README.md` §2 apply verbatim. In addition:

- **Branch:** `v2-cutover`. Never merge to `dev`/`main` until the run-level review gate passes and Task 10's ledger row is written.
- **V1 freeze ends with this run, but only where this plan says so.** `packages/opencode/src/session/prompt.ts`, `processor.ts`, `session.ts`, `retry.ts`, `run-state.ts`, `status.ts` receive bugfixes only through Task 7; Tasks 8–10 delete them. If any task seems to require a V1 feature, escalate instead of adding it.
- **One session engine at the end.** After Task 8 the public loop is `SessionV2.Service`; the legacy loop is gone. The `SessionPrompt.loop` bridge (`AGENTS.md` "never bridge V2 through legacy `SessionPrompt.loop`") is physically removed, not merely avoided.
- **One journal at the end.** Task 0 picks option A or B; the pick is recorded in `docs/architecture/v2-journal-cutover.md` and every later task marked `[A]`/`[B]` follows it. Whichever option is chosen, no TS code may write journal files directly (`TODO/README.md` §2.4; `crates/ultracode-events/README.md` invariant 4).
- **System Context invariants:** keep the algebra, registry, and built-ins in `packages/core/src/system-context`; Context Source producers keep their observed domains; Session History selection and Context Epoch persistence stay Session-owned (root AGENTS.md "V2 Session Core"). A plugin transform that mutates the *durable* epoch baseline is a defect.
- **Provenance:** provider-family base prompts are the repo's OWN files (`packages/opencode/src/session/prompt/*.txt`), so no ledger entry is required to port them. This run reads no code from `../codex` or `../claude-code-sourcemap`; if any subagent introduces such code, escalate (this is not expected).
- **Sidecar wire semantics:** do not change the JSON-RPC envelope or idempotency-key conventions in `crates/ultracode-events/src/rpc.rs`; option-A work is additive (new `EventKind` values + validation/projection), never a break of `propose_commit`'s shape. Rust changes must pass `cargo test -p ultracode-events` and `cargo clippy -p ultracode-events -- -D warnings` from repo root.
- **API changes:** after changing public Protocol/Server `HttpApi`, run `bun run generate` from `packages/client`; never hand-edit `packages/client/src/generated*`.
- **Testing:** no mocks unless no alternative; never touch `globalThis`; test real implementations; do not copy implementation logic into tests. Never run tests from repo root — run from the owning package dir.

## Orchestrator Brief

### Context Files (read in full before dispatching any subagent; verify with `test -f`)

1. `specs/v2/session.md` — the V1 Runtime Context Parity checklist is the source of truth for Tasks 1 and 3; also the delivery vocabulary, compaction, and projectors contracts.
2. `packages/core/src/session.ts` — `SessionV2.Service`; the `shell/skill/compact/wait` stubs at ~387–424 and the `OperationUnavailableError` schema at 95–100.
3. `packages/core/src/session/projector.ts` — the dual projection into `MessageTable`/`PartTable` (V1) and `SessionMessageTable`/`SessionInputTable`/`SessionTable` (V2) that Task 8 must split.
4. `packages/core/src/session/input.ts` — `SessionInput.admit/promoteSteers/promoteNextQueued`, `Delivery` (`steer`/`queue`); the admission contract the migration must preserve.
5. `packages/core/src/session/execution.ts` — `SessionExecution.Service` (`active/resume/wake/interrupt/supervise`), `TerminalRunResult`, `SupervisionInput`; used by `shell/skill/compact/wait` and the shadow harness.
6. `packages/core/src/session/runner/index.ts`, `runner/llm.ts`, `runner/model.ts` — the V2 runner; `RunError`, `Limits`, `RunResult`; `model.ts` is where RUN-05 lands `CapabilityProfile`.
7. `packages/core/src/system-context/{index,registry,builtins}.ts` and `packages/core/src/instruction-context.ts` — the algebra + registry; `core/instructions` already honors `OPENCODE_DISABLE_PROJECT_CONFIG`.
8. `packages/ultracode-context/src/blocks.ts` + `compiler/kernel.ts` — `buildSystemPlan`/`compileContext`; where provider-family blocks and structured-output blocks join the plan.
9. `packages/opencode/src/session/prompt.ts` (skim for feature inventory), `processor.ts`, `session.ts`, `retry.ts`, `run-state.ts`, `status.ts`, `system.ts`, `reminders.ts`, `instruction.ts`, `tools.ts` — the legacy behavior the parity rows name.
10. `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` + `groups/session.ts` — every legacy session route the handler flip must cover (24 handlers).
11. `packages/opencode/src/session/prompt/*.txt` — the 14 provider-family base-prompt files (1256 lines) ported into `@ultracode/context` blocks.
12. `packages/plugin/src/index.ts` (the `experimental.chat.*.transform` hook signatures at 282–296) and `packages/opencode/src/agent/agent.ts` (~381, the only `system.transform` call site).
13. `crates/ultracode-events/README.md` (invariants 1–5), `src/rpc.rs` (`propose_commit` at ~167–200), `src/event.rs` (`EventKind`, which already carries `SessionStarted/TurnStarted/UserInputCommitted/...`), `src/import.rs` + `src/bin/import-legacy.rs` (the migration substrate).
14. `packages/opencode/src/sync/README.md` — the sync/EventV2 read-model invariants Task 0 must respect under both options.
15. `packages/cli/src/commands/commands.ts` (`migrate` Spec), `packages/cli/src/commands/handlers/migrate.ts` (stub), `packages/cli/src/framework/runtime.ts` — the CLI migration host.
16. `packages/core/src/config/experimental.ts`, `packages/opencode/src/effect/runtime-flags.ts` — where `experimental.v2Session`/`experimental.v2Shadow` wiring lands.
17. `packages/opencode/test/session/prompt.test.ts`, `packages/core/test/session-runner-recorded.test.ts`, `packages/core/test/session-projector.test.ts`, `packages/opencode/test/server/httpapi-session.test.ts` — test-harness and recording patterns Tasks 1, 5, 9 reuse.
18. Sibling-run outputs from `TODO/README.md` §7 Cross-Run Interface Registry (RUN-02 `core/memory`, RUN-03 `Tools.Service.register`/`materialize`, RUN-04 `CompactionCheckpoint`/`cache-edit`, RUN-05 `CapabilityProfile`, RUN-08 streaming-parallel settlement). Tasks that consume them MUST NOT run before the producing run is ledger-DONE.

### Baselines (record before Task 0)

```bash
cd packages/core && bun test test/session-runner.test.ts test/session-projector.test.ts test/session-prompt.test.ts 2>&1 | tail -8
cd packages/core && bun typecheck
cd packages/opencode && bun test test/session test/server/httpapi-session.test.ts 2>&1 | tail -8
cd packages/opencode && bun typecheck
cargo test -p ultracode-events 2>&1 | tail -5
cd packages/ultracode-context && bun test 2>&1 | tail -5
git status --short
```

### Dispatch Order

Task 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 strictly sequential. Task 0 is a decision checkpoint, not code: it gates the `[A]`/`[B]` annotations on Tasks 4–8. Tasks 1–3 are parity and do not consume sidecar interfaces, so they can proceed regardless of the journal pick. Do not dispatch Task 4 until Tasks 0–3 pass Stage-A gates.

### Definition of Done (verify each with a command you ran)

- [ ] `specs/v2/session.md` parity table: every row `complete` or explicitly `accepted-with-owner`; the checked-in burndown table in this run's docs (`docs/session/parity-burndown.md`) is 100% green.
- [ ] `SessionV2.shell/skill/compact/wait` return typed results, never `OperationUnavailableError` (`rg "OperationUnavailableError" packages/core/src/session.ts` → zero hits).
- [ ] `cargo test -p ultracode-events` and `cargo clippy -p ultracode-events -- -D warnings` green (option A).
- [ ] Shadow-run diff report command `opencode debug v2-shadow-diff` exits 0 with zero diff rows on the fixture corpus.
- [ ] `opencode migrate` on a fixture legacy DB is idempotent (second run reports 0 new rows) and preserves session lineage + per-message token sums + prompt admission rows.
- [ ] With `experimental.v2Session=true`, every session route in `httpapi-session.test.ts` passes against `SessionV2`; with the flag absent, behavior is unchanged (default OFF).
- [ ] `packages/opencode/src/session/prompt.ts`, `processor.ts`, `retry.ts` deleted; `message/part` projection removed and tables archived; `rg "SessionPrompt" packages/opencode/src` → only safe references in tests explicitly re-pointed at V2.
- [ ] Existing session http-recorder cassettes + e2e session tests replay green against V2 (Task 9 regression gate).
- [ ] Root `AGENTS.md` "V2 Session Core" + `ULTRACODE.md` §4 owner table updated to the single-engine reality; run ledger row + Cross-Run Interface Registry entry appended.
- [ ] `bun typecheck` passes in `packages/core`, `packages/opencode`, `packages/ultracode-context`, `packages/cli`; `git status` clean; branch `v2-cutover`.

---

### Task 0: Journal decision checkpoint (decision doc only, no product code)

**Files:**
- Create: `docs/architecture/v2-journal-cutover.md` (2 pages max)
- Test: none (this task's "test" is the review gate that the doc answers all four required questions with file:line evidence)

**Interfaces:**
- Consumes: `crates/ultracode-events/README.md` invariants 1–5; `crates/ultracode-events/src/rpc.rs` `propose_commit` flow (lines ~167–200); `crates/ultracode-events/src/event.rs` `EventKind` (session-shaped vocabulary already present: `SessionStarted`, `TurnStarted`, `UserInputCommitted`, `ContextPlanned`, `PromptCompiled`, `ProviderAttemptStarted/Completed`, `ToolProposed`, `ToolStarted`, `ToolResultCommitted`, `AssistantMessageCommitted`, `TurnCompleted`, `TurnAborted`); `packages/opencode/src/sync/README.md` (EventV2 as read-model/pubsub projection, sync-event invariants); `TODO/README.md` §7 RUN-13 row; `ULTRACODE.md` §4 one-owner rules.
- Produces: the decision in `docs/architecture/v2-journal-cutover.md`; the run's `[A]`/`[B]` annotation that Tasks 4–8 must follow verbatim.

- [ ] **Step 1: Read the invariants.** Read in full: `crates/ultracode-events/README.md`, `crates/ultracode-events/src/rpc.rs` (propose_commit region), `packages/opencode/src/sync/README.md`, `ULTRACODE.md` §4. Record in the doc, with file:line, how each source constrains the choice.

- [ ] **Step 2: Write the decision doc** `docs/architecture/v2-journal-cutover.md`. It must contain exactly:

  1. **The question.** Sessions are currently the single authority of EventV2 (TS SQLite). The sidecar is the mandated single journal. Where do session events durably live after this run?
  2. **Option A** — route session events through `propose_commit` now: every V2 `SessionEvent` is committed to the sidecar journal with idempotency key `session:<sessionID>:<seq>`; EventV2 becomes the TS read-model/pubsub projection over the sidecar (`SessionEvent` rows rebuilt from journal replay). Cost: Rust `EventKind` values for `SessionEvent.*`, validation + projection in the sidecar, a TS journal bridge, recovery tests. Benefit: satisfies `ULTRACODE.md` §4 now, unblocks RUN-14 (daemon workers own session trees through sidecar claims) and future clustered execution.
  3. **Option B** — keep EventV2 as the session journal; the sidecar read-model consumes its projections (a TS→sidecar mirror for the DAG/approval surfaces that already journal there). Cost: two authorities remain for session state permanently (explicitly rejected by audit §18-A2 because it "enshrines the exact 'two authorities' ambiguity your charter forbids and blocks clustered session execution later").
  4. **Decision + rationale.** The plan is predisposed toward **Option A**: `ULTRACODE.md` §4 mandates one journal, the sidecar already carries the session-shaped `EventKind` vocabulary (evidence: `event.rs` lines 28–121), the sidecar README names "routing the live session flow through the sidecar" as the deferred Stage-3 work, and audit §18-A2/§27-2 recommend it. Task 0 must CONFIRM or REJECT A with evidence from the four sources; if evidence contradicts the predisposition (e.g., `propose_commit` validation cannot be extended without a wire break — that is a BLOCKER, escalate), write B instead.
  5. **Adaptation table**: Tasks 4–8 listed with their `[A]`/`[B]` annotation.

- [ ] **Step 3: Review gate.** Have the orchestrator read the doc and verify all four sections answer with evidence. The doc is not a placeholder — it states a concrete pick. If the pick is A, Task 4 proceeds to Rust+TS; if B, Task 4 proceeds to the mirror.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/v2-journal-cutover.md
git commit -m "docs: v2 journal cutover decision"
```

---

### Task 1: V1 Runtime Context Parity burndown test matrix (one test per row) `[A]/[B]-neutral`

**Files:**
- Create: `packages/core/test/session/parity/harness.ts`
- Create: `packages/core/test/session/parity/context-parity.test.ts`
- Create: `docs/session/parity-burndown.md`
- Modify: `specs/v2/session.md` (append a "Burndown test matrix" subsection; do NOT change any status cell in this task — that happens in Task 3/8)

**Interfaces:**
- Consumes: `SessionV2` (`packages/core/src/session.ts`), `SessionEvent` (`packages/core/src/session/event.ts`), `SessionInput` (`packages/core/src/session/input.ts`), the runner (`packages/core/src/session/runner/index.ts`), the recorded-LLM harness pattern from `packages/core/test/session-runner-recorded.test.ts`.
- Produces: `SessionContext.render(session, model, agent)` — a pure Effect that assembles the exact model-visible system blocks the runner would lower (reusing `buildSystemPlan` from `@ultracode/context`), exported from `packages/core/src/session/context/render.ts`. Also `TestSessionHarness` in `parity/harness.ts` with:
  - `create(opts): Promise<TestSessionHarness>` (with `sessionID`, `dir`; pins a deterministic model `{ providerID: "anthropic", modelID: "claude-sonnet-4" }` so provider-family selection in `parity:provider-family-base-instructions` is stable)
  - `admit(prompt: PromptInput.Prompt): Effect<Admitted>` (aliases `SessionV2.prompt` with `resume: false`)
  - `runTurn(prompt, opts?: { format?: { type: "json_schema"; schema: unknown } }): Promise<{ system: string[]; messages: unknown[]; tools: Record<string, unknown>; request?: { settings?: unknown }; structured?: unknown; events: SessionEvent.DurableEvent[] }>` — from the recorded LLM request; every field present on the return type (some may be `undefined`)
  - `durableSessionMessages(): Effect<SessionMessage.Message[]>`
  - `durableInputs(): Effect<Admitted[]>`
  - `events(): Effect<SessionEvent.DurableEvent[]>`
  - `stubActive(set: Set<SessionID>): void` (swaps the `SessionExecution` stub's active set)

- [ ] **Step 1: Write the failing harness test.** Create `parity/harness.ts` with `TestSessionHarness.create(opts: { dir: string; agent?: string }): Promise<{ sessionID: string; admit(...); runTurn(...); render() }>`, built on the recorded-LLM + `AppNodeBuilder` pattern from `session-runner-recorded.test.ts` (read it first; reuse its `Effect`/`Layer`/`Database` wiring verbatim where possible). Write a smoke test asserting `runTurn()` returns a `system` array containing the identity block and the `core/environment` env text.

- [ ] **Step 2: Run, watch it fail.**

Run: `cd packages/core && bun test test/session/parity/context-parity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the harness + render.** Create `packages/core/src/session/context/render.ts` exporting `render(session, model, agent)` that: loads the epoch baseline (`SessionContextEpoch`), appends the agent/request assembly blocks via `buildSystemPlan`, and returns `{ baseline: string[], blocks: ContextBlock[] }`. Wire the harness to call `render` and the recorder LLM. Keep `render` pure (no db writes).

- [ ] **Step 4: Write all 21 parity tests** in `context-parity.test.ts`, one `test()` per row of the checklist, names `parity:<short behavior>`:

```ts
import { describe, test, expect } from "bun:test"
import { TestSessionHarness } from "./harness"

describe("V1 runtime context parity", () => {
  test("parity:env-date-provider-identity", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-env" })
    const { system } = await h.runTurn("list the environment")
    expect(system.join("\n")).toContain("Working directory:")
    expect(system.join("\n")).toContain("Today's date:")
    expect(system.join("\n")).toContain("You are powered by the model named")
  })
  test("parity:instructions-discovery", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-instr" })
    const { system } = await h.runTurn("go")
    // global + upward AGENTS.md content is rendered; legacy CLAUDE.md is NOT discovered (accepted-with-owner)
    expect(system.join("\n")).toContain("Instructions from:")
  })
  test("parity:configured-instructions", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-cfg" })
    const { system } = await h.runTurn("go")
    expect(system.join("\n")).toContain("config instructions marker")
  })
  test("parity:nearby-nested-instructions", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-nested" })
    const { system } = await h.runTurn("read src/a.ts")
    expect(system.join("\n")).toContain("nested AGENTS.md marker")
  })
  test("parity:skill-guidance-filtered", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-skill" })
    const { system, tools } = await h.runTurn("list skills")
    expect(system.join("\n")).toContain("Skills provide specialized instructions")
  })
  test("parity:request-assembly-baseline", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-base" })
    const { system } = await h.runTurn("hi")
    expect(system.length).toBeGreaterThan(0)
  })
  test("parity:agent-prompt-and-policy", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-agent", agent: "custom" })
    const { system } = await h.runTurn("hi")
    expect(system.join("\n")).toContain("<agent_instructions>")
  })
  test("parity:provider-family-base-instructions", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-family" })
    const { system } = await h.runTurn("hi")
    // family-specific directive ported from prompt/<family>.txt
    expect(system.join("\n")).toMatch(/anthropic|gemini|gpt|beast|default/)
  })
  test("parity:tool-materialization", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-tools" })
    const { tools } = await h.runTurn("hi")
    expect(Object.keys(tools)).toContain("read")
  })
  test("parity:per-prompt-overrides", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-overrides" })
    const { system } = await h.runTurn("hi")
    // per-prompt system text admitted durably and replayed on exact retry
    expect(system.join("\n")).toContain("override marker")
  })
  test("parity:reminders", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-remind", agent: "plan" })
    const { system } = await h.runTurn("plan this")
    expect(system.join("\n")).toContain("plan")
  })
  test("parity:plugin-transforms", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-plugin" })
    const { system } = await h.runTurn("hi")
    expect(system.join("\n")).toContain("plugin-injected-marker")
  })
  test("parity:model-variants-settings", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-variant" })
    const { request } = await h.runTurn("hi")
    expect(request.settings).toBeDefined()
  })
  test("parity:structured-output", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-structured" })
    const out = await h.runTurn("return JSON", { format: { type: "json_schema", schema: {} } })
    expect(out.structured).toBeDefined()
  })
  test("parity:auto-compaction", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-compact" })
    await h.admit("fill history")
    const { events } = await h.runTurn("long")
    expect(events.some((e) => e.type === "Compaction.Ended")).toBe(true)
  })
  test("parity:typed-attachments", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-attach" })
    const admitted = await h.admit({ text: "read this", files: [{ uri: "file:///tmp/parity-attach/a.md" }] })
    expect(admitted.prompt.files).toHaveLength(1)
  })
  test("parity:mention-expansion", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-mention" })
    const admitted = await h.admit("@./a.md what does this say")
    expect(admitted.prompt.files).toHaveLength(1)
  })
  test("parity:attachment-materialization", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-mat" })
    const out = await h.runTurn("read the file")
    expect(out.messages.some((m) => m.content.includes("file content"))).toBe(true)
  })
  test("parity:agent-reference", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-agref" })
    const out = await h.runTurn("@code-reviewer check this")
    expect(out.messages.some((m) => m.content.includes("code-reviewer"))).toBe(true)
  })
  test("parity:configured-reference", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-cref" })
    const out = await h.runTurn("@docs what is this")
    expect(out.messages.some((m) => m.content.includes("reference content"))).toBe(true)
  })
  test("parity:synthetic-replay", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/parity-synth" })
    await h.admit("summarize")
    const rows = await h.durableSessionMessages()
    expect(rows.some((r) => r.type === "synthetic")).toBe(true)
  })
})
```

- [ ] **Step 5: Run the matrix.** Rows already `complete` (request-assembly-baseline, auto-compaction, typed-attachments) should pass immediately. Rows `partial`/`missing` must fail with a clear assertion message. Record the per-row pass/fail into `docs/session/parity-burndown.md` as the starting status table (copy the 21 rows from `specs/v2/session.md`, add columns `Test name`, `Task that closes`, `Status`).

Run: `cd packages/core && bun test test/session/parity/context-parity.test.ts`
Expected: mixed pass/fail — the 3 complete rows green, ≥10 rows red (each red assertion is the burndown backlog for Tasks 2–3).

- [ ] **Step 6: Typecheck + commit.**

Run: `cd packages/core && bun typecheck`
Commit: `git add packages/core/test/session/parity packages/core/src/session/context docs/session/parity-burndown.md specs/v2/session.md && git commit -m "test(core): v1 runtime context parity burndown matrix"`

---

### Task 2: Close V2 gaps batch 1 — `SessionV2.shell/skill/compact/wait` `[A]/[B]-neutral`

**Files:**
- Modify: `packages/core/src/session.ts` (replace stubs at ~387–424)
- Create: `packages/core/src/session/methods/shell.ts`, `methods/skill.ts`, `methods/compact.ts`, `methods/wait.ts`
- Test: `packages/core/test/session/session-methods.test.ts`

**Interfaces:**
- Consumes: `SessionInput.admit` + `Delivery` (input.ts), `SessionEvent` (event.ts), `SessionExecution.Service` (execution.ts), `SessionRunner` + `Limits` (runner/index.ts), `SessionCompaction` (`packages/core/src/session/compaction.ts` — RUN-04 extends this with `CompactionCheckpoint` + `cache-edit` policy flag; consume those when present, degrade to current API otherwise and note the deviation), `Skill.Service` (`packages/core/src/skill`), and the `TestSessionHarness` from Task 1 — **extended in this task** with `shell(command): Effect<void>`, `skill(name): Effect<void>`, `compact(): Effect<void>`, `wait(): Effect<void>`, `sessionID: string` (the extension lives in `parity/harness.ts` alongside the Task 1 helpers).
- Produces:
  - `shell(input: { id?; sessionID; command; resume? }): Effect<void, NotFoundError>` — admits the command as a user prompt (`Prompt.make({ text: command })`, `delivery: "steer"`, `resume: input.resume ?? true`) and returns void. Reuses `SessionV2.prompt`.
  - `skill(input: { id?; sessionID; skill; resume? }): Effect<void, NotFoundError | SkillNotFoundError>` — resolves the skill via `Skill.Service.get(skill)`; on success admits a synthetic guidance message (see below) with the skill body as model-visible text; on missing skill fails `SkillNotFoundError` (new `Schema.TaggedErrorClass` `"Session.SkillNotFoundError"`, field `skill: string`, added to `packages/core/src/session.ts`).
  - `compact(input: { sessionID; prompt? }): Effect<void, NotFoundError>` — publishes `SessionEvent.Compaction.Started` (idempotency: no-op when a compaction is already in flight, tracked by a process-local `Set<SessionID>`), runs the V2 compaction adapter over projected history, publishes `SessionEvent.Compaction.Ended`, then `execution.wake(sessionID)`.
  - `wait(id: SessionID): Effect<void, NotFoundError | WaitTimeoutError>` — joins the active drain: polls `execution.active` until `id` leaves the set or 120s elapse; on timeout fails `WaitTimeoutError` (new `Schema.TaggedErrorClass` `"Session.WaitTimeoutError"`, field `sessionID`). Idle sessions resolve immediately (no-op), matching `interrupt`'s idle-no-op convention.

- [ ] **Step 1: Write the failing tests** in `session-methods.test.ts` (pattern: `session-prompt.test.ts` in core — build a Session, stub `SessionExecution` layer, assert durable rows):

```ts
import { describe, test, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionInputTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "../lib/effect"
// reuse the harness from Task 1 (extended in this task) for setup

describe("SessionV2 shell/skill/compact/wait", () => {
  test("shell admits a steer prompt with the command text", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/m-shell" })
    await Effect.runPromise(h.shell("ls -la"))
    const inputs = await Effect.runPromise(h.durableInputs())
    expect(inputs).toHaveLength(1)
    expect(inputs[0].delivery).toBe("steer")
    expect(inputs[0].prompt.text).toBe("ls -la")
  })
  test("skill loads the skill body as model-visible synthetic guidance", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/m-skill" })
    await Effect.runPromise(h.skill("code-review"))
    const msgs = await Effect.runPromise(h.durableSessionMessages())
    expect(msgs.some((m) => m.type === "synthetic" && m.data.text.includes("review checklist"))).toBe(true)
  })
  test("skill with an unknown name fails SkillNotFoundError, not OperationUnavailableError", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/m-skill-missing" })
    const exit = await Effect.runPromiseExit(h.skill("does-not-exist"))
    expect(Exit.isFailure(exit)).toBe(true)
  })
  test("compact publishes Compaction.Started then Compaction.Ended", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/m-compact" })
    await Effect.runPromise(h.compact())
    const events = await Effect.runPromise(h.events())
    const kinds = events.map((e) => e.type)
    expect(kinds).toContain("Compaction.Started")
    expect(kinds).toContain("Compaction.Ended")
  })
  test("wait on an idle session resolves immediately", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/m-wait-idle" })
    await expect(Effect.runPromise(h.wait())).resolves.toBeUndefined()
  })
  test("wait on a never-idle session times out with WaitTimeoutError", async () => {
    const h = await TestSessionHarness.create({ dir: "/tmp/m-wait-timeout" })
    h.stubActive(new Set([h.sessionID])) // SessionExecution stub reports this session as always active
    await expect(Effect.runPromise(h.wait())).rejects.toMatchObject({ _tag: "Session.WaitTimeoutError" })
  })
})
```

- [ ] **Step 2: Run, watch fail.** `cd packages/core && bun test test/session/session-methods.test.ts` → `OperationUnavailableError` failures / missing modules.

- [ ] **Step 3: Implement.** Add the two error classes to `packages/core/src/session.ts` (`SkillNotFoundError`, `WaitTimeoutError`) and the union to `Session.Error`. Create the four `methods/*.ts` modules, each exporting an Effect.fn used by `SessionV2`'s layer; replace the stubs in `session.ts` with calls into them. `compact` and `wait` must not take a Session ID (`AGENTS.md` "no layer should take a Session ID" — they take the Session ID as data, which is the existing `SessionV2` interface shape; preserve it).

- [ ] **Step 4: Run, watch pass.** `cd packages/core && bun test test/session/session-methods.test.ts` → 6 pass. Then `bun typecheck`.

- [ ] **Step 5: Commit.** `feat(core): implement SessionV2 shell, skill, compact, wait over existing primitives`

---

### Task 3: Close V2 gaps batch 2 — provider-family blocks, reminders, plugin transform, structured output, mentions, references, configured instructions `[A]/[B]-neutral`

**Files:**
- Create: `packages/ultracode-context/src/provider-family.ts`
- Create: `packages/core/src/system-context/reminders.ts`
- Create: `packages/core/src/system-context/instructions.ts`
- Create: `packages/core/src/session/runner/system-transform.ts`
- Create: `packages/core/src/session/runner/structured-output.ts`
- Create: `packages/core/src/session/reference/expand.ts`
- Modify: `packages/ultracode-context/src/blocks.ts` (provider-family + structured-output block wiring)
- Modify: `packages/core/src/session/runner/index.ts` + `runner/llm.ts` (request assembly: system-transform seam, structured output, provider identity line)
- Modify: `packages/core/src/session.ts` (per-prompt overrides: `prompt` accepts optional `system`/`tools` overrides, admitted durably, replayed on exact retry)
- Modify: `packages/core/src/instruction-context.ts` (configured + remote instructions source with precedence)
- Modify: `packages/opencode/src/agent/agent.ts` (narrow system.transform port)
- Test: `packages/core/test/session/parity/context-parity.test.ts` (flip the matching rows green), plus `packages/core/test/session/parity/mention-expansion.test.ts` and `packages/ultracode-context/test/provider-family.test.ts`

**Interfaces:**
- Consumes: `SystemContext` algebra (`packages/core/src/system-context/index.ts`), `SystemContextRegistry.Service`, `SessionContextEpoch` (`packages/core/src/session/context-epoch.ts`), `Prompt`/`PromptInput` (`@opencode-ai/schema/prompt`), `Reference.Service` (`packages/core/src/reference`), `AgentV2` (`packages/core/src/agent`), `Skill.Service`, runner `request` assembly (`packages/core/src/session/runner/llm.ts`), `ConfigV2` (`packages/core/src/config.ts`).
- Produces:
  - `providerFamilyPrompt(model: { providerID: string; modelID: string }): string` — ported family base prompt (repo-own `.txt` content); `providerFamilyBlocks(model): ContextBlock[]` — a `ContextBlock` wrapping it, `stability: "session-stable"`, `provenance: "provider-family"`. Selection logic mirrors `packages/opencode/src/session/system.ts:27-42` (`muse-spark→meta`, `gpt-4|o1|o3→beast`, `codex→codex`, `gpt→gpt`, `gemini-→gemini`, `claude→anthropic`, `trinity→trinity`, `kimi→kimi`, else default). Agent override: when the effective agent has a `prompt`, the agent block replaces the family block (`blocks.ts`).
  - `RemindersSource` — a `core/reminders` System Context source keyed `SystemContext.Key.make("core/reminders")`; observes `(agent, planFileState, flags)` and renders the plan-mode / plan→build-switch reminder intent from `packages/opencode/src/session/reminders.ts` as an *advisory chronological update* (never a durable user-message part). `load` returns `SystemContext.empty` when no reminder applies.
  - `SystemTransform.Service` — `Context.Service<SystemTransform.Service, { transform: (system: string[]) => Effect.Effect<string[]> }>`; provided by the Location layer. **Decision (implemented): port `experimental.chat.system.transform` narrowly** — the runner calls `transform` on the ephemeral per-request `system` array AFTER the epoch baseline is rendered and BEFORE lowering to the provider request; the transform result is NOT persisted to the epoch baseline (a persistent mutation would break the Context Epoch immutability invariant). The opencode layer wires the plugin trigger (`packages/plugin/src/index.ts:291`) into this service. `messages.transform` is likewise applied to the ephemeral request messages, not to durable rows. Plugin-defined Context Sources are explicitly deferred (specs `session.md` "Expose plugin-defined Context Sources only after plugin reload and scoped cleanup semantics are designed") and noted in the burndown table as `accepted-with-owner` for that sub-row.
  - `structuredOutputPolicy(format)` + `createStructuredOutputTool(schema, onSuccess)` in `runner/structured-output.ts` — when `lastUser.format?.type === "json_schema"`: add the `structured-output` block (via `blocks.ts`, reuse `STRUCTURED_OUTPUT_SYSTEM_PROMPT`), inject a generated `StructuredOutput` tool (port the `STRUCTURED_OUTPUT_DESCRIPTION` + `createStructuredOutputTool` behavior from `packages/opencode/src/session/prompt.ts:76,1244-1251,1573`), set `toolChoice: "required"`, capture the structured payload onto the assistant message's `structured` field, and fail `StructuredOutputError` when the model never produced it.
  - `expandPromptInput(input, ctx): Effect<PromptInput.Prompt>` in `reference/expand.ts` — runs BEFORE `SessionInput.admit`: parses `@mention` tokens (`ConfigMarkdown`-compatible file/glob/`~`/absolute, plus `@<agent>` and `@<reference>`), resolves file → `{type:"file", uri, filename, mime}`, agent → `{type:"agent", name}`, reference → configured `Reference` content materialized into the prompt (or a durable failure part for unresolved aliases), and attaches to `prompt.files`/`prompt.agents`. Also `materializeAttachments(prompt, ctx): Effect<Prompt>` which reads file/dir/media content into attachment payloads for the model request (dir → listing; binary media → base64 data URI; MCP resources → normalized `{uri, text|blob}`).
  - `core/instructions` extended (instruction-context.ts): configured file/glob + remote-URL instruction sources with precedence order `[global AGENTS.md, upward AGENTS.md, configured files, configured URLs]`, V1-style 5s fetch timeout + transient retry, `OPENCODE_DISABLE_PROJECT_CONFIG` honored (project-only sources skipped), unavailable source preserved-as-previous (existing `SystemContext.unavailable` semantics). Legacy `CLAUDE.md`/`CONTEXT.md` discovery: **accepted-with-owner = no** (documented decision; AGENTS.md is the single canonical name, avoids a second instruction owner).
  - `SessionV2.prompt` gains optional `system?: string[]` and `tools?: Record<string, boolean>` overrides persisted on the admitted `session_input` row (durable replay on exact retry) — new column on `SessionInputTable` (`prompt_overrides` JSON), added in a `packages/core` migration; the runner applies them at request assembly.

- [ ] **Step 1: provider-family tests.** `packages/ultracode-context/test/provider-family.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { providerFamilyPrompt, providerFamilyBlocks } from "../src/provider-family"

describe("providerFamilyPrompt", () => {
  test("selects the anthropic family for claude model ids", () => {
    expect(providerFamilyPrompt({ providerID: "anthropic", modelID: "claude-sonnet-4" })).toContain("claude")
  })
  test("selects the gemini family for gemini model ids", () => {
    expect(providerFamilyPrompt({ providerID: "google", modelID: "gemini-2.5-pro" })).toContain("gemini")
  })
  test("falls back to default for unknown families", () => {
    expect(providerFamilyPrompt({ providerID: "acme", modelID: "z-1" })).toContain("You are")
  })
  test("returns a session-stable privileged block", () => {
    const [block] = providerFamilyBlocks({ providerID: "anthropic", modelID: "claude-sonnet-4" })
    expect(block.stability).toBe("session-stable")
    expect(block.trust).toBe("privileged")
    expect(block.provenance).toBe("provider-family")
  })
})
```

- [ ] **Step 2: Run, watch fail.** `cd packages/ultracode-context && bun test test/provider-family.test.ts` → module missing. Implement `provider-family.ts` by porting the behavioral intent (identity line, family-specific operational directives) from the repo's `packages/opencode/src/session/prompt/*.txt` into a single exported text-selection function; keep `default` covering unknown families.

- [ ] **Step 3: Reminders + configured-instructions tests.** In `packages/core/test/session/parity/context-parity.test.ts`, flip the `parity:reminders` and `parity:configured-instructions` tests' expected markers to the actual rendered strings, then run to confirm they now pass against the new sources. Also add `parity:nearby-nested-instructions` — nested AGENTS.md discovered after a successful read (port `Instruction.resolve` behavior from `packages/opencode/src/session/instruction.ts:179-221` into the instruction source's observed domain).

- [ ] **Step 4: Implement reminders + instructions.** `system-context/reminders.ts` registers `core/reminders`; `system-context/instructions.ts` extends the `core/instructions` observation with configured files/URLs. Both register with `SystemContextRegistry`. Wire `core/reminders` into the runner's reconcile domain (safe-boundary reconciliation already calls `SystemContext.reconcile` — the reminders source just joins the registry).

- [ ] **Step 5: System-transform seam tests.** In `parity/context-parity.test.ts`, `parity:plugin-transforms` — configure a test `SystemTransform` layer that appends `"plugin-injected-marker"`, run a turn, assert the marker appears in the recorded request `system` but NOT in the epoch baseline (query `SessionContextEpochTable`). Implement `runner/system-transform.ts` + call it in `runner/llm.ts` request assembly. In `packages/opencode/src/agent/agent.ts`, replace the inline `plugin.trigger("experimental.chat.system.transform", ...)` with the new seam (same hook name; the layer provides the trigger).

- [ ] **Step 6: Structured output tests + implementation.** In `parity/context-parity.test.ts`, `parity:structured-output` — the recorder LLM scripted to return a `StructuredOutput` tool call with the JSON payload; assert `out.structured` equals the payload and the assistant message persists `structured`. Implement `runner/structured-output.ts` and wire into `runner/llm.ts` (block, tool injection, toolChoice, result capture, `StructuredOutputError` on missing).

- [ ] **Step 7: Mention/reference tests + implementation.**

```ts
// packages/core/test/session/parity/mention-expansion.test.ts
import { describe, test, expect } from "bun:test"
import { expandPromptInput } from "@opencode-ai/core/session/reference/expand"

describe("expandPromptInput", () => {
  test("expands a file mention before admission", async () => {
    const out = await expandPromptInput({ text: "@./a.md summarize", files: [], agents: [] }, { dir: "/tmp" })
    expect(out.files).toHaveLength(1)
    expect(out.files[0].filename).toBe("./a.md")
  })
  test("expands an agent mention", async () => {
    const out = await expandPromptInput({ text: "@reviewer check", files: [], agents: [] }, { dir: "/tmp" })
    expect(out.agents).toContain("reviewer")
  })
  test("unresolved @alias yields a durable failure part, not a crash", async () => {
    const out = await expandPromptInput({ text: "@nope what", files: [], agents: [] }, { dir: "/tmp" })
    expect(out).toBeDefined()
  })
})
```

Implement `reference/expand.ts` (parse + resolve file/agent/reference), `materializeAttachments` (dir listing, media data-URIs, MCP resources normalized), and agent-reference guidance at request assembly (permission-aware: a globally denied agent expands to a failure text, not its prompt).

- [ ] **Step 8: Per-prompt overrides.** Add `prompt_overrides` column via `packages/core/script/migration.ts` (run `cd packages/core && bun run migration`), update `SessionInputTable`, extend `SessionInput.admit` to persist overrides, apply in the runner; add `parity:per-prompt-overrides` assertion.

- [ ] **Step 9: Run the full parity matrix** and update `docs/session/parity-burndown.md` statuses. Rows `complete`: request-assembly-baseline, auto-compaction, typed-attachments, provider-family, reminders, plugin-transforms (system+message), structured-output, mention-expansion, attachment-materialization, agent-reference, configured-reference, configured-instructions, env-date-provider-identity, instructions-discovery (accepted-with-owner: no CLAUDE.md/CONTEXT.md), agent-prompt-and-policy, tool-materialization, model-variants-settings, per-prompt-overrides, nearby-nested-instructions, skill-guidance-filtered, synthetic-replay. Exactly 21/21 green or explicitly accepted-with-owner.

Run: `cd packages/core && bun test test/session/parity && bun typecheck` and `cd packages/ultracode-context && bun test && bun typecheck`.

- [ ] **Step 10: Commit.** `feat(core): v2 parity batch 2 — provider-family blocks, reminders, transforms, structured output, mentions, references, configured instructions`

---

### Task 4: Journal cutover implementation for the chosen option `[A]` primary / `[B]` fallback

> `[A]` path below. If Task 0 chose B, replace the Rust step with a TS→sidecar mirror per the doc's adaptation table (still TDD, same gates) and annotate the deviation.

**Files:**
- Create: `crates/ultracode-events/src/session.rs` (validation + projection for session event kinds)
- Modify: `crates/ultracode-events/src/rpc.rs` (call the new validation in `propose_commit`; additive only)
- Create: `packages/core/src/event/sidecar-journal.ts` (`SidecarSessionJournal`)
- Modify: `packages/core/src/event/index.ts` (`EventV2.publish` becomes: sidecar commit then read-model projection)
- Test: `crates/ultracode-events/src/session.rs` (Rust unit tests, same style as `import.rs`), `packages/core/test/event/sidecar-journal.test.ts`

**Interfaces:**
- Consumes: `@ultracode/events-client` (`EventsClient`, `startSupervised`/`start` — RUN-01), `EventKind` (`crates/ultracode-events/src/event.rs`), `propose_commit`/`list_events` (rpc.rs), `EventV2` (`packages/core/src/event/index.ts`), `SessionEvent` (`packages/core/src/session/event.ts`).
- Produces:
  - Rust: `validate_session_event(kind: &EventKind) -> Result<(), String>` — accepts only `SessionStarted`, `TurnStarted`, `UserInputCommitted`, `ContextPlanned`, `PromptCompiled`, `ProviderAttemptStarted`, `ProviderAttemptCompleted`, `ToolProposed`, `ToolStarted`, `ToolResultCommitted`, `AssistantMessageCommitted`, `TurnCompleted`, `TurnAborted`; rejects any event whose `session_id`/`root_id` fields are inconsistent with the journal's known roots (mirror `validate_task_event_from_journal`). Register it inside `propose_commit`'s validation block.
  - TS: `SidecarSessionJournal` with `commit(event: SessionEvent.Event): Effect<{ seq: number; hash: string }, JournalError>` using idempotency key `session:<sessionID>:<seq>` and a journal-mirrored `SessionEvent.Synthetic`-preserving replay; `EventV2.publish` for `SessionEvent.*` definitions routes through it, then projects into the existing read-model tables. `JournalError` (tagged, `_tag: "SessionJournalError"`, field `message`).
  - Recovery test: kill the sidecar mid-commit, restart, replay — the event exists exactly once (idempotent key).

- [ ] **Step 1: Rust failing tests.** `crates/ultracode-events/src/session.rs`:

```rust
#[test]
fn session_event_kind_is_accepted_by_validate_session_event() {
    let kind = EventKind::TurnStarted { /* fields per event.rs */ };
    assert!(validate_session_event(&kind).is_ok());
}

#[test]
fn unknown_root_session_is_rejected() {
    // Journal has no session "ghost"; a TurnStarted claiming it must fail.
    let kind = EventKind::TurnStarted { /* session "ghost" */ };
    assert!(validate_session_event(&kind).is_err());
}
```

- [ ] **Step 2: Run, watch fail.** `cargo test -p ultracode-events session` → module missing.
- [ ] **Step 3: Implement Rust validation** + wire into `rpc.rs` `propose_commit` (after the existing three validators). Run `cargo test -p ultracode-events` and `cargo clippy -p ultracode-events -- -D warnings`.
- [ ] **Step 4: TS bridge tests.** `packages/core/test/event/sidecar-journal.test.ts` — start a supervised sidecar on a tmp journal dir, publish a `SessionEvent.PromptAdmitted` via `SidecarSessionJournal.commit`, then `list_events` and assert the event round-trips with the same `seq`; re-publish the same key and assert `duplicate: true` (no second row). Also the crash-restart once-only test (mirror RUN-01 Task 2's fake-sidecar discipline).
- [ ] **Step 5: Implement `sidecar-journal.ts`** and rewire `EventV2.publish` for `SessionEvent.*` definitions. Keep the read-model projection exactly as-is; only the durable store changes.
- [ ] **Step 6: Run all core session tests** (`cd packages/core && bun test test/session`) — must be green (the read model is behavior-preserving), plus `bun typecheck`.
- [ ] **Step 7: Commit.** `feat(ultracode-events): route session events through the sidecar journal` (TS commit) + `feat(core): sidecar session journal bridge with idempotent replay` (separate commit).

---

### Task 5: Shadow-run harness — `experimental.v2Shadow` flag, fixture corpus, diff report `[A]`/`[B]`: diff reads the sidecar journal under A, EventV2 under B (identical `ShadowDiffRow` shape)

**Files:**
- Modify: `packages/core/src/config/experimental.ts` (add `v2Session: Schema.Boolean`, `v2Shadow: Schema.Boolean`, defaults `false`)
- Modify: `packages/opencode/src/effect/runtime-flags.ts` (add `experimentalV2Session: enabledByExperimental("OPENCODE_EXPERIMENTAL_V2_SESSION")`, `experimentalV2Shadow: enabledByExperimental("OPENCODE_EXPERIMENTAL_V2_SHADOW")`)
- Create: `packages/opencode/src/session/v2-shadow.ts` (`ShadowDiffService`)
- Create: `packages/opencode/src/commands/v2-shadow-diff.ts` (debug command)
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` (prompt/promptAsync: when `v2Shadow` is on, ALSO admit the same prompt to a throwaway V2 shadow session and record the diff)
- Create: `packages/core/test/session/parity/fixtures/*.jsonl` (corpus: 5 prompt-turn transcripts covering steer, queue, retry, compaction, tool calls — authored, deterministic)
- Test: `packages/opencode/test/session/v2-shadow.test.ts`, `packages/core/test/session/parity/shadow-corpus.test.ts`

**Interfaces:**
- Consumes: `SessionV2` (`packages/core/src/session.ts`), legacy `SessionPrompt` + `MessageV2` (`packages/opencode/src/session/`), `RuntimeFlags`, `Database` (`packages/core/src/database/database.ts` — shadow DB is a throwaway in-memory/`:memory:` instance).
- Produces: `ShadowDiffService` with `runCorpus(corpusPath): Effect<ShadowReport>` and `ShadowReport = { cases: number; diffs: ShadowDiffRow[] }`, `ShadowDiffRow = { corpusId; eventType; legacy: unknown; v2: unknown; detail: string }`. `shadow(sessionID, prompt)` performs: admit the prompt to the legacy session (unchanged user-visible path) AND, in an isolated shadow DB, `SessionV2.prompt` + drain; compares durable `session_message`/`session_input` rows vs the legacy `message`/`part` rows for the same admitted prompts; shadow failures are logged and never returned to the caller. Command `opencode debug v2-shadow-diff --corpus <path>` prints the report and exits non-zero when any diff row is present (DoD).

- [ ] **Step 1: Config + flags tests.** Assert `ConfigV2.Experimental` decodes `{ "v2Session": true, "v2Shadow": true }` and defaults to `false` when absent; `RuntimeFlags` reads the env names. Implement.
- [ ] **Step 2: Fixture corpus.** Author `fixtures/*.jsonl`: each line `{"case":"steer","sessionID":"ses-1","prompt":{...}}`; covers steer, queue, exact-retry, compaction-triggering history, and a tool-call turn. Add `shadow-corpus.test.ts` asserting the corpus loads and each case admits to V2 without error.
- [ ] **Step 3: Shadow service failing test** — `v2-shadow.test.ts`: with a tmp legacy DB + isolated shadow DB, run `ShadowDiffService.runCorpus` on a corpus containing one deliberately-drifted prompt (V2 drops a synthetic part V1 keeps — use the pre-Task-3 state to make it red), assert a diff row names the event type and both sides. Then implement `v2-shadow.ts`.
- [ ] **Step 4: Handler hook.** In `handlers/session.ts` `prompt`/`promptAsync`, when `RuntimeFlags.experimentalV2Shadow`, fork a shadow admission (isolated DB, `resume: false`) and record the diff; never affect the returned stream. Add a test that with the flag on, `prompt` still returns the legacy stream and the shadow rows land only in the shadow DB.
- [ ] **Step 5: Command + DoD.** `v2-shadow-diff.ts` wires `ShadowDiffService.runCorpus` into the CLI (`packages/opencode` debug command tree). Run it on the fixture corpus and record the report in the run ledger.
- [ ] **Step 6: Typecheck + commit.** `cd packages/opencode && bun typecheck`; commit `feat(opencode): v2 shadow-run harness with diff report command`.

---

### Task 6: Data migration — `opencode migrate` completion + lineage/prompt-admission/token-accounting preservation `[A]` (import-legacy → journal → replay) / `[B]` (legacy tables → EventV2 directly); shared `replayLegacyToV2` core keeps semantics identical

**Files:**
- Modify: `packages/cli/src/commands/handlers/migrate.ts` (replace the stub)
- Modify: `packages/cli/src/commands/commands.ts` (extend `migrate` Spec with params: `--db`, `--journal-dir`, `--dry-run`)
- Create: `packages/cli/src/services/migrate.ts` (`runMigration(opts)`)
- Create: `packages/cli/test/migrate.test.ts`
- Create: `packages/core/src/session/migrate/replay.ts` (`replayLegacyToV2`)

**Interfaces:**
- Consumes: `import_legacy` binary (`crates/ultracode-events/src/bin/import-legacy.rs` — verified present, idempotent keys `legacy-session-{id}`/`legacy-message-{id}`), `SessionV2` create/prompt, `SessionEvent`, `SessionInput.admit`, usage extraction from `step-finish` parts (the projector already does this at `projector.ts:36-42` and `applyUsage` at 90–110).
- Produces: `runMigration({ db, journalDir, dryRun })` that (1) shells `import-legacy --source-db <db> --journal-dir <journalDir> [--dry-run]` and captures `ImportReport`; (2) reads the legacy `session`/`session_message`/`message`/`part` tables read-only; (3) for each session creates the V2 Session (reusing the legacy ID to preserve lineage — `SessionV2.create({ id })`), admits each user message via `SessionInput.admit` (delivery `steer`), marks already-visible messages promoted (publish `Prompted`), and replays assistant messages + parts as durable `SessionEvent` messages; (4) folds per-message usage from `step-finish` parts into the session's token columns (reuse the `applyUsage` arithmetic); (5) idempotent — re-running reports 0 new rows and leaves the DB byte-identical.

- [ ] **Step 1: Failing migration test** — `packages/cli/test/migrate.test.ts`: build a fixture legacy DB (mirror `import.rs`'s `OPENCODE_DDL` + a `part` table with a `step-finish` row carrying `tokens`/`cost`), run `runMigration({ dryRun: true })` and assert the report counts + zero writes; then run non-dry-run and assert: session lineage (`SessionV2.get` returns the legacy ID), token sums match the fixture parts, `session_input` rows exist for every user message (admission preserved), and a second run is a no-op.
- [ ] **Step 2: Run, watch fail.** `cd packages/cli && bun test test/migrate.test.ts` → stub logs "No migrations to run."
- [ ] **Step 3: Implement `replayLegacyToV2` + `runMigration`.** Keep the sidecar as the journal destination under option A (import-legacy writes the journal; replay reads `list_events`); under option B read the legacy tables directly. Both paths use the same `replayLegacyToV2(db, rows, events)` core so the semantics are option-independent.
- [ ] **Step 4: Run, watch pass.** `cd packages/cli && bun test test/migrate.test.ts` → green. Then `cd packages/cli && bun typecheck`.
- [ ] **Step 5: Commit.** `feat(cli): complete v1→v2 migrate with lineage and token accounting`

---

### Task 7: HTTP handler flip to V2 behind `experimental.v2Session` (default OFF) `[A]/[B]-neutral`

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
- Create: `packages/opencode/src/server/routes/instance/httpapi/handlers/session-v2.ts`
- Modify: `packages/opencode/src/effect/runtime-flags.ts` (flag added in Task 5)
- Test: `packages/opencode/test/server/httpapi-session-v2.test.ts`

**Interfaces:**
- Consumes: `SessionV2.Service` (core), the existing route group schema (`groups/session.ts`), `RuntimeFlags.experimentalV2Session`, `SessionError.mapStorageNotFound`-style error mapping.
- Produces: a `sessionV2Handlers` group that mirrors every route the legacy group serves (`list, status, get, children, todo, diff, messages, message, create, remove, update, fork, abort, init, share, unshare, summarize, prompt, promptAsync, command, shell, revert, unrevert, permissionRespond, deleteMessage, deletePart, updatePart`) by delegating to `SessionV2` + the existing `Todo`/`Summary`/`Revert` services where V2 has no equivalent yet (documented in the handler). The `prompt`/`promptAsync`/`shell` handlers call `SessionV2.prompt/shell`; `abort` calls `SessionV2.interrupt`; `status` reads `SessionExecution.active`; `init` is removed per `specs/v2/session.md` "Remove Dedicated `session.init` Route". The legacy group is selected when the flag is OFF (one release), the V2 group when ON.

- [ ] **Step 1: Failing parity tests** — `httpapi-session-v2.test.ts`: with `RuntimeFlags.experimentalV2Session` set true, exercise every route against a tmp instance; assert the same status codes and body shapes as `httpapi-session.test.ts` for the read paths, and for `prompt` that the V2 session grows a `session_message` row. Use the existing `httpapi-layer.ts` harness.
- [ ] **Step 2: Run, watch fail.** `cd packages/opencode && bun test test/server/httpapi-session-v2.test.ts` → module missing.
- [ ] **Step 3: Implement `session-v2.ts` + flip.** Add the flag branch at the group assembly point. Keep the legacy group fully intact while the flag is off.
- [ ] **Step 4: Run both suites.** `cd packages/opencode && bun test test/server/httpapi-session.test.ts test/server/httpapi-session-v2.test.ts` → both green; run `bun run generate` from `packages/client` only if the Protocol changed (it should not — the route surface is unchanged). `bun typecheck`.
- [ ] **Step 5: Commit.** `feat(opencode): serve session http api from SessionV2 behind experimental.v2Session`

---

### Task 8: Decommission — delete legacy loop, stop dual projection, archive tables `[A]` (drop `message`/`part` from live schema, archive to sidecar-backed rows) / `[B]` (archive within EventV2 SQLite); the TS table migration differs, the deletion list does not

**Files:**
- Delete: `packages/opencode/src/session/prompt.ts`, `processor.ts`, `retry.ts`
- Delete (conditional, verify zero importers first): `packages/opencode/src/session/system.ts`, `reminders.ts`, `instruction.ts`, and any other `@/session/*` module that becomes unreferenced once `prompt.ts`/`processor.ts`/`retry.ts` are gone (provider-family + reminders + configured instructions already live in `@ultracode/context`/core after Task 3). Run the `rg` audit in Step 1; delete only what is provably orphaned; keep any module the HTTP handlers still consume (`message-v2.ts`, `summary.ts`, `revert.ts`, `todo.ts`, `session.ts`, `run-state.ts`→re-point, `status.ts`→re-point, `compaction.ts`→re-point to V2).
- Modify: `packages/opencode/src/session/status.ts` (point at `SessionExecution.active`; remove legacy busy-state calls) — or delete and re-point `run-state.ts` consumers; audit callers with `rg -n "SessionPrompt|SessionProcessor|SessionRetry" packages/opencode/src` first and re-point each
- Modify: `packages/core/src/session/projector.ts` (remove `MessageTable`/`PartTable` projections; keep `SessionTable`/`SessionMessageTable`/`SessionInputTable`)
- Create: `packages/core/script/archive-v1-tables.ts` (migration: rename `message`→`message_archived_v1`, `part`→`part_archived_v1`; run via `cd packages/core && bun run migration`)
- Modify: `packages/opencode/src/event-v2-bridge.ts` (stop publishing V1-only `SessionV1.Event.*` shadow events for session mutations)
- Modify: `packages/opencode/src/agent/agent.ts` (remove the now-unreachable `Agent.generate` V1 path or re-point it at `SessionV2`; verify by `rg`)
- Modify: `packages/opencode/src/session/prompt/*.txt` (delete after Task 3 ports — `rg "prompt/" packages/opencode/src` shows zero remaining importers)
- Test: `packages/opencode/test/session/decommission.test.ts`, `packages/core/test/session/projector-v2-only.test.ts`

**Interfaces:**
- Consumes: everything Tasks 1–7 produced; `SessionEvent` projection set minus the V1 tables.
- Produces: a repo where `rg "SessionPrompt|SessionProcessor|SessionRetry|message_archived_v1|part_archived_v1" packages/opencode/src packages/core/src` returns only deliberate references (archive names in migrations/tests). The `decommission.test.ts` suite drives one full V2 session (admit → drain → tool call → compact) and asserts all reads go through `SessionMessageTable`/`SessionInputTable` and that `message`/`part` tables are absent from the schema.

- [ ] **Step 1: Caller audit.** Run `rg -n "SessionPrompt|SessionProcessor|SessionRetry|from \"@/session/prompt\"|from \"@/session/processor\"|from \"@/session/retry\"" packages/opencode/src` and enumerate every caller into the decommission plan's deviation log; re-point each at the V2 service (or delete the caller) BEFORE deleting files. The TUI/app/CLI must compile with zero legacy-session imports.
- [ ] **Step 2: Failing decommission tests** — `projector-v2-only.test.ts`: publish a `Prompted` + `Tool.Called` + `Tool.Success` sequence and assert only `SessionMessageTable`/`SessionInputTable`/`SessionTable` rows are written (no `MessageTable`/`PartTable`). `decommission.test.ts`: end-to-end session through V2 with the legacy files deleted.
- [ ] **Step 3: Remove V1 projections** from `projector.ts` (the `SessionV1.Event.MessageUpdated/MessageRemoved/PartUpdated/PartRemoved` handlers at ~262–330 and the `usage()`/`applyUsage` V1 usage folding), migrate/archive the tables.
- [ ] **Step 4: Delete legacy files + txts**, re-point callers, update `event-v2-bridge.ts`.
- [ ] **Step 5: Run the full affected suites.** `cd packages/core && bun test test/session && bun typecheck`; `cd packages/opencode && bun test test/session test/server && bun typecheck`.
- [ ] **Step 6: Commit.** `refactor(opencode): decommission legacy session loop and dual projection`

---

### Task 9: Conformance — replay existing e2e + http-recorder cassettes against V2 `[A]/[B]-neutral`

**Files:**
- Create: `packages/opencode/test/session/conformance/README.md` (gate definition)
- Modify: `packages/opencode/test/session/prompt.test.ts`, `session.test.ts`, `structured-output-integration.test.ts` etc. — re-point the harness at the V2 runner (flag ON) and mark each `parity:`/`conformance:` test; any test that legitimately tests V1-only internals is deleted with a one-line note in the run ledger
- Test: the re-pointed suites + a cassette replay: run the recorded `llm-native-recorded.test.ts` pattern with `experimental.v2Session=true` through `@opencode-ai/http-recorder`

**Interfaces:**
- Consumes: the Task 5 shadow corpus + `@opencode-ai/http-recorder` cassettes, the recorded-LLM harness.
- Produces: a `conformance/` gate whose exit criteria are: (1) every V2 re-pointed test green with the flag ON; (2) cassette replay of a recorded 20-turn session produces identical durable `session_message`/`session_input` rows under the flag OFF vs ON for the legacy-vs-V2 read models; (3) zero regressions in `packages/opencode/test/server/httpapi-session.test.ts`.

- [ ] **Step 1: Write the gate test** — replay a recorded cassette twice (legacy path vs V2 path, same corpus), assert durable rows equal.
- [ ] **Step 2: Run, watch fail.** `cd packages/opencode && bun test test/session/conformance` → the drift cases identified by Task 5's diff report show up here as failures; fix forward in V2 only (no V1 feature additions).
- [ ] **Step 3: Re-point and re-run** all session suites with `experimental.v2Session=true`; delete only genuinely V1-internal tests, documenting each in the run ledger.
- [ ] **Step 4: Commit.** `test(opencode): session conformance gate on v2 runner`

---

### Task 10: Docs, run ledger, and parity 100% `[A]/[B]-neutral`

**Files:**
- Modify: `specs/v2/session.md` (parity table statuses → `complete`; "V1 Runtime Context Parity" note updated to reflect the single engine)
- Modify: `AGENTS.md` (root) "V2 Session Core" — update to the single-engine reality, remove the "never bridge" caveat that now describes removed code
- Modify: `ULTRACODE.md` §4 owner table — mark the session loop/journal owners as single-owner-post-cutover, or note the cutover in the relevant section
- Modify: `docs/session/parity-burndown.md` (100% green table)
- Modify: `TODO/README.md` §7 Cross-Run Interface Registry (RUN-13 row already present; fill the produced symbols) and §8 Run Ledger (append the row with commit range + deviations)
- Create: `docs/session/v2-cutover-summary.md` (one page: what changed, what was deleted, migration path, how to enable `experimental.v2Session`)

**Interfaces:**
- Consumes: the final commit hashes of Tasks 0–9 and the parity table from Task 3/8.
- Produces: the run ledger row and registry entry (only commit hashes and verified test output; no prose invented after the fact).

- [ ] **Step 1: Update parity table** in `specs/v2/session.md` — every row `complete` or `accepted-with-owner` (list the accepted-with-owner rows and their owners in the table's "Remaining V2 work" column).
- [ ] **Step 2: Update AGENTS.md + ULTRACODE.md** per the file list.
- [ ] **Step 3: Finalize burndown + summary docs.**
- [ ] **Step 4: Run the full verification battery** exactly as listed in Definition of Done and record outputs verbatim in the ledger.
- [ ] **Step 5: Commit.** `docs: run-13 session cutover completion and parity 100%`

---

## Run-Level Review Prompt (dispatch after Task 10)

```
Review the commits <list hashes> in /home/thymia/UltraCode-Planning/opencode
implementing RUN-13 (file: opencode/TODO/RUN-13-v2-session-cutover.md).
Run-specific checks:
1. One session engine: `rg "SessionPrompt|SessionProcessor|SessionRetry" packages/opencode/src`
   returns zero hits; `message`/`part` tables absent from live schema (only *_archived_v1 or tests).
2. One journal: no TS code writes journal files directly; under option A every SessionEvent
   commits through propose_commit with `session:<id>:<seq>` keys; under option B the mirror
   preserves the same idempotency discipline.
3. Parity table honest: every row in specs/v2/session.md is `complete` or explicitly
   `accepted-with-owner` with an owner named; no row silently left `missing`.
4. No OperationUnavailableError remains for shell/skill/compact/wait.
5. System Context invariants: the durable epoch baseline is never mutated by the plugin
   transform seam (transform applies to the ephemeral request only).
6. HTTP flip is flag-gated: `experimental.v2Session` defaults OFF; legacy group intact when off.
7. Migration preserves lineage, admission rows, and token sums; re-run is idempotent.
8. Diff scope: only files declared in the run plan (check `git show --stat` per commit).
Then the generic checks from TODO/README.md §5.1 items 1–5.
Reply numbered findings, BLOCKER or MINOR, file:line. No edits.
```

## Deviation Log (fill during execution)

| Task | Deviation | Reason |
|---|---|---|

## Parity Burndown Status Table (starting state; update in Task 3 and Task 8)

Source: `specs/v2/session.md` lines 129–151. Status: `complete` | `partial` | `missing`. Closing task: 3, 8, or `accepted-with-owner`.

| # | Boundary | Behavior | Status (start) | Test | Closes |
|---|---|---|---|---|---|
| 1 | Durable Context Source | Environment facts + host-local date (+ provider/model identity) | partial | `parity:env-date-provider-identity` | T3 |
| 2 | Durable Context Source | Global + upward project instructions | partial | `parity:instructions-discovery` | T3 (CLAUDE.md/CONTEXT.md: accepted-with-owner = no) |
| 3 | Durable Context Source | Configured local/glob + remote URL instructions | missing | `parity:configured-instructions` | T3 |
| 4 | Durable Context Source | Nearby nested instructions after successful reads | missing | `parity:nearby-nested-instructions` | T3 |
| 5 | Durable Context Source | Skill guidance + skill-body loading (permission-filtered) | partial | `parity:skill-guidance-filtered` | T3 |
| 6 | Per-turn request assembly | Placement, model, chronological history, lowering | complete | `parity:request-assembly-baseline` | — |
| 7 | Per-turn request assembly | Agent prompt + effective permissions | partial | `parity:agent-prompt-and-policy` | T3 |
| 8 | Per-turn request assembly | Provider/model-specific base instructions | missing | `parity:provider-family-base-instructions` | T3 |
| 9 | Per-turn request assembly | Policy-filtered tool materialization | partial | `parity:tool-materialization` | T3 |
| 10 | Per-turn request assembly | Per-prompt system text + tool overrides | missing | `parity:per-prompt-overrides` | T3 |
| 11 | Per-turn request assembly | Steering, plan/build-switch, final-step reminders | missing | `parity:reminders` | T3 |
| 12 | Per-turn request assembly | Plugin message/system/parameter/header transforms | missing | `parity:plugin-transforms` | T3 (system.transform: narrow port; plugin Context Sources: accepted-with-owner = deferred) |
| 13 | Per-turn request assembly | Model variants + request settings | partial | `parity:model-variants-settings` | T3 |
| 14 | Per-turn request assembly | Structured-output policy | missing | `parity:structured-output` | T3 |
| 15 | Per-turn request assembly | Automatic/context-pressure compaction | complete | `parity:auto-compaction` | — |
| 16 | Prompt/reference expansion | Durable typed prompt attachments | complete | `parity:typed-attachments` | — |
| 17 | Prompt/reference expansion | Native template + `@` mention expansion | missing | `parity:mention-expansion` | T3 |
| 18 | Prompt/reference expansion | File/dir/media/MCP-resource materialization | partial | `parity:attachment-materialization` | T3 |
| 19 | Prompt/reference expansion | Agent-reference expansion | missing | `parity:agent-reference` | T3 |
| 20 | Prompt/reference expansion | Configured-reference expansion | missing | `parity:configured-reference` | T3 |
| 21 | Prompt/reference expansion | Native synthetic expansion replay | partial | `parity:synthetic-replay` | T3 |
