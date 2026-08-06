# RUN-02: Memory Wiring — System Context Source, Extraction Jobs, Review Surface

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the fully-built but orphaned `packages/ultracode-memory` package and wire it into the live session: a System Context source that injects a bounded memory block into the provider-cache baseline, a sidecar job queue that runs LLM extraction after compaction and at session idle, and a public review/edit/delete API with privacy controls.

**Architecture:** Read path runs at safe provider-turn boundaries as a context source (epoch-durable, cache-stable). Write path is asynchronous and journaled: `Compaction.Ended` and idle signals enqueue `memory_jobs` rows claimed once each via the sidecar (idempotency per RUN-01); a worker extracts candidate memories with a small model, redacts secrets, and stores records with freshness/provenance metadata. Review happens over versioned HTTP APIs in a new Protocol group.

**Tech Stack:** Bun, TypeScript, Effect-TS, Drizzle/SQLite, Rust sidecar RPC (one additive method), `@ultracode/memory`, `@ultracode/context` stability tiers.

**Audit basis:** §5.5 (orphaned memory), §18-A1.1, §17.3 (Claude memdir caps: ≤5 records, ≤4KB each, ≤60KB session cumulative — adopt verbatim), TODO.md "Personalization and Memory" (both items; this run is the only accepted implementation).

## Global Constraints

`TODO/README.md` §2 applies verbatim. Additions:

- Memory is **opt-in** (`memory.enabled`, default `false`) and project-scoped by default; global scope requires explicit `memory.scope: "global"`.
- Secret redaction cannot be disabled; config may only narrow, never widen, what counts as a secret.
- The memory block renders as **one** context source (`core/memory`) — never inline memory text into other sources or the V1 prompt assembly (one-owner rule).
- Injection caps are hard invariants: ≤5 records/turn, ≤4KB/record, ≤60KB cumulative per session-epoch, records sorted by (freshness desc, key asc) for determinism.
- Branch: `memory-wiring`.

## Orchestrator Brief

### Context Files (read in full before Task 1)

1. `packages/ultracode-memory/src/*.ts` (list them all first: `ls packages/ultracode-memory/src`) — record format, extraction pipeline, consolidation, retrieval/ranking, redaction. Write down the exported function signatures in the run ledger; subagent prompts must use them verbatim.
2. `packages/ultracode-memory/README.md` and `packages/ultracode-memory/package.json` (confirm zero dependents: `rg -l "ultracode-memory" packages --include package.json`).
3. `packages/core/src/system-context/{index,registry,builtins}.ts` — the algebra (`make`, `combine`, `initialize/reconcile/replace`), and how a source with `key`, `codec`, `load`, `baseline`, `update`, `removed` is written. Model every subagent's code on `builtins.ts`.
4. `packages/core/test/system-context/` — existing source tests; copy their harness shape.
5. `packages/core/src/session/context-epoch.ts` and `packages/core/src/session/runner/llm.ts` (the `SystemContext.initialize/prepare/replace` call sites).
6. `crates/ultracode-events/src/projections.rs` (the `memory_*` tables), `crates/ultracode-events/src/rpc.rs` (handler list).
7. `packages/schema/src/` layout and `packages/protocol/src/` one existing small group (e.g. skill) as the template for the new `memory` group; `packages/client` README "generate" section.
8. `packages/opencode/src/agent/scheduler-service.ts` for the audit-bridge pattern (how an EventV2 subscription becomes a sidecar commit).

### Baselines

```bash
cd packages/core && bun test test/system-context 2>&1 | tail -5
cd packages/ultracode-memory && bun test 2>&1 | tail -5
cd packages/protocol && bun typecheck 2>&1 | tail -3
cargo test -p ultracode-events 2>&1 | tail -3
rg -n "memory_" crates/ultracode-events/src/projections.rs | head -20
```

### Dispatch Order

Tasks 1 → 7 sequential. Task 4 touches Rust; Tasks 5–7 touch Protocol (client regen in Task 6).

### Definition of Done

- [ ] With `memory.enabled: true` and two stored records in the project store, a new V2 session's provider request contains one `core/memory` block of ≤4KB listing ≤5 records, in deterministic order (`rg "core/memory"` the test snapshots).
- [ ] After a compaction completes in a session with memory enabled, exactly one `memory_jobs` row exists for that session (SQL query against the sidecar projection), it is claimed exactly once even if two idle signals race, and completing it writes ≥1 candidate record through `ultracode-memory` with redaction applied (integration test).
- [ ] `GET /memory/records` pages (opaque cursors, per CONTEXT.md), `DELETE /memory/records/:id` removes the record from the next epoch's block, `PATCH` edits persist provenance (`edited_by: "user"`, timestamp).
- [ ] With `memory.enabled` absent, nothing changes in the system context and no jobs are enqueued (test both).
- [ ] `bun run generate` re-ran from `packages/client`; generated artifacts committed.
- [ ] `bun typecheck` green in `packages/{core,protocol,server,client,ultracode-memory,opencode}`; `cargo test -p ultracode-events` green.

---

### Task 1: Characterize `ultracode-memory` (behavior-pinning tests)

**Files:**
- Test: `packages/ultracode-memory/test/characterization.test.ts`

**Interfaces:**
- Consumes: the package's real exports (from Context File 1 notes).
- Produces: a passing characterization suite documenting: create/append record, freshness decay, redaction on write, retrieval caps enforced, consolidation merge behavior. No source changes in this task.

- [ ] **Step 1:** Write tests pinning CURRENT behavior for the five behaviors above. Example skeleton (adapt names to the real exports you inventoried):

```ts
import { describe, test, expect } from "bun:test"
// import the real inventory here, e.g. { createRecord, retrieveRelevant, redactSecrets }
// from "@ultracode/memory" — exact names from your Context File 1 notes.

describe("characterization: redaction", () => {
  test("stored record never contains a matched secret", async () => {
    const rec = await createRecord({ kind: "preference", text: "my aws key is AKIAIOSFODNN7EXAMPLE" })
    expect(rec.text).not.toContain("AKIAIOSFODNN7EXAMPLE")
  })
})
```

If current behavior VIOLATES an invariant (e.g. caps not enforced), do NOT fix it in this task — mark the test `.fails` with a comment and note it in the deviation log; Task 2+ will fix forward.

- [ ] **Step 2:** Run `cd packages/ultracode-memory && bun test test/characterization.test.ts` — expect the new suite to run (some `.fails` markers allowed).
- [ ] **Step 3:** Commit — `test(ultracode-memory): pin existing memory behavior before wiring`

---

### Task 2: `core/memory` System Context source (read path)

**Files:**
- Create: `packages/core/src/memory/source.ts`
- Create: `packages/core/src/memory/select.ts` (pure selection: filters, caps, sorting)
- Test: `packages/core/test/memory/source.test.ts`, `packages/core/test/memory/select.test.ts`

**Interfaces:**
- Consumes: `SystemContext.make/combine` (Context File 3), `ultracode-memory` retrieval exports, config `memory.*` (add config schema keys in this task: `packages/opencode` config or `packages/core/src/config` — find the V2 config home via `rg "compaction.auto" packages/core/src/config` and follow that pattern).
- Produces:
  - `MemorySource` context source with key `core/memory`; `load` returns `{ records: MemoryRecord[] }`; codec = JSON of `{key, hash, updatedAt}[]`; `baseline` renders the ≤4KB block listing `## Memory` with one `-` line per record (`title` + relative freshness); `update` renders the full new block (whole-aggregate supersede, single source); `removed` renders exactly `"Previously loaded memory no longer applies."`.
  - `selectForInjection(records, { maxRecords: 5, maxBytesPerRecord: 4096, maxTotalBytes: 61440, now }): MemoryRecord[]` — pure.

- [ ] **Step 1: Failing tests** — `select.test.ts` first (pure, no Effect): six cases — cap count, cap per-record bytes (truncate with marker appended), cap cumulative (drop lowest-freshness with counter `"+N more memories"`), tie-sort determinism, empty input, redaction re-check on selection (defense in depth). Then `source.test.ts`: initialize → baseline renders block; reconcile with same codec value → `Unchanged`; reconcile with changed set → `Updated` whose text equals the full new block; removal path.

- [ ] **Step 2–5:** run/fail → implement `select.ts` then `source.ts` (model on `builtins.ts` exactly: same shape, same error style) → run/pass → `cd packages/core && bun typecheck`.

- [ ] **Step 6: Commit** — `feat(core): core/memory system context source with injection caps`

---

### Task 3: Register the source into the V2 runner assembly

**Files:**
- Modify: `packages/core/src/session/runner/llm.ts` (or the Location-scoped registry assembly module — find where `builtins` are registered: `rg "core/environment" packages/core/src`)
- Modify: config schema files to expose `memory.enabled`, `memory.scope`
- Test: `packages/core/test/memory/integration.test.ts`

**Interfaces:**
- Consumes: `MemorySource` (Task 2); Location-scoped `SystemContextRegistry`.
- Produces: when `memory.enabled`, the registry contains `core/memory` before epoch initialization; when disabled, no source and zero memory I/O.

- [ ] **Step 1: Failing integration test** — boot the V2 runner harness used in existing `packages/core/test/session` tests (find one: `rg -l "runTurnAttempt|SessionRunner" packages/core/test`), seed a memory store with 2 records, run one provider turn with a stub LLM client (check how existing tests stub `llm.stream` — reuse that layer), assert the captured request's `system` array contains a part matching `/## Memory/` and the redacted title.

- [ ] **Step 2–5:** run/fail → implement registration behind config → run/pass → typecheck.

- [ ] **Step 6: Commit** — `feat(core): register memory source in V2 runner behind memory.enabled`

---

### Task 4: Sidecar RPC `enqueue_memory_job` (Rust, additive)

**Files:**
- Modify: `crates/ultracode-events/src/rpc.rs` (handler registration)
- Modify: `crates/ultracode-events/src/projections.rs` (only if a claim column is missing — inspect `memory_jobs` schema first)
- Modify: `packages/ultracode-events-client/src/index.ts` (client method)
- Test: `crates/ultracode-events/tests/` (follow existing test layout; add `memory_jobs.rs`), `packages/ultracode-events-client/test/memory-jobs.test.ts`

**Interfaces:**
- Produces: RPC `enqueue_memory_job { key, session_id, reason } -> { enqueued: bool }` (idempotent on `key`); `claim_memory_job { } -> { job | null }` (atomic claim, marks `claimed_at`); `complete_memory_job { key, outcome } -> { ok: bool }`. Client: `enqueueMemoryJob`, `claimMemoryJob`, `completeMemoryJob`.

- [ ] **Step 1: Failing Rust test** — enqueue same key twice → second returns `enqueued: false`; two claims → only one returns the job; complete unknown key → error.

- [ ] **Step 2–5:** run/fail (`cargo test -p ultracode-events memory_jobs`) → implement (validate against in-memory projection like other `propose_commit` handlers; keep journal append pattern identical to neighbors) → run/pass → client method + client test with the fake/real sidecar → `cargo clippy -p ultracode-events -- -D warnings`.

- [ ] **Step 6: Commit** — `feat(ultracode-events): memory job queue with once-claim semantics`

---

### Task 5: Extraction triggers and worker

**Files:**
- Create: `packages/opencode/src/memory/worker.ts`
- Create: `packages/opencode/src/memory/triggers.ts`
- Modify: `packages/opencode/src/agent/scheduler-service.ts` (subscribe pattern) OR a dedicated `MemoryService.layer` if cleaner — choose by fitting existing layer patterns.
- Test: `packages/opencode/test/memory/worker.test.ts`

**Interfaces:**
- Consumes: Task 4 RPCs; EventV2 `SessionEvent.Compaction.Ended` subscription; an idle signal (use session status transitions already exposed by `sessions.active()`/EventV2 — find the cheapest existing signal; do NOT invent a new event bus).
- Produces: on trigger → `enqueueMemoryJob({ key: mem:<sessionID>:<seq>, session_id, reason })`; worker loop claims jobs, runs the existing `ultracode-memory` extraction against the session's recent messages (read via `SessionStore`), writes candidate records, completes the job; worker is per-process, sequential, with a `Set` claiming-guard so two local triggers never double-run the same key even before the RPC.

- [ ] **Step 1: Failing test** — fake client (from RUN-01 fixture reuse) + stubbed extraction seam (inject a function `extract(messages) => candidates`; dependency-inject, do NOT mock the module): compaction-ended event leads to exactly one enqueued key under duplicate signals; worker completes the job and store contains redacted candidates.

- [ ] **Step 2–5:** run/fail → implement → run/pass → typecheck.

- [ ] **Step 6: Commit** — `feat(opencode): memory extraction worker over sidecar job queue`

---

### Task 6: Public `memory` Protocol group + client regen

**Files:**
- Create: `packages/protocol/src/memory.ts` (group: `list` (paged, opaque cursor), `get`, `patch`, `delete`)
- Modify: `packages/protocol/src/index.ts` (or wherever groups are composed) + `packages/server` handler module (find sibling handler dir: `rg -l "HttpApiGroup" packages/opencode/src/server | head`)
- Create: `packages/server` handler for memory (mirror the skill/skill-group handler's structure)
- Regen: `packages/client` via `bun run generate`

**Interfaces:**
- Consumes: ultracode-memory store reads; cursor discipline from CONTEXT.md §171–175 (opaque branded cursor; initial query carries filters/page size; continuation carries only cursor).
- Produces: endpoints listed in DoD; errors: `MemoryNotFoundError` (unknown id), `MemoryDisabledError` (when `memory.enabled` false → 409 style failure, not 404).

- [ ] **Step 1: Failing handler tests** — `packages/opencode/test/server/memory.test.ts` (mirror an existing handler test): list pages with cursor; patch persists `edited_by: "user" + ts`; delete removes from store; disabled config → `MemoryDisabledError`.

- [ ] **Step 2–5:** run/fail → implement Schema → Protocol → Server in that dependency order → run/pass → `cd packages/client && bun run generate` → typecheck server+client.

- [ ] **Step 6: Commit** — `feat(protocol): memory review API with paged records` + `chore(sdk): regenerate types` (two commits).

---

### Task 7: Docs, config reference, run ledger

**Files:**
- Modify: `packages/ultracode-memory/README.md` (mark wired; document injection caps + privacy)
- Create: `packages/core/src/memory/README.md` — 10 lines max: source key, caps, epoch behavior, config keys.
- Modify: `TODO/README.md` §7 (tick the RUN-02 registry rows) and §8 ledger.

- [ ] **Step 1:** Write the docs; verify every config key named in docs exists in the schema file (`rg "memory" packages/core/src/config* packages/opencode/src/config* -l`).
- [ ] **Step 2:** Commit — `docs(memory): wiring notes, caps, privacy defaults`

---

## Run-Level Review Prompt (dispatch after Task 7)

```
Review commits <hashes> implementing RUN-02 (opencode/TODO/RUN-02-memory-wiring.md).
Run-specific checks:
1. Single owner: memory text enters the model EXCLUSIVELY via the core/memory
   context source; grep the diff for any other system-prompt/string path
   carrying memory content.
2. Caps: ≤5 records, ≤4KB/record, ≤60KB/epoch, deterministic ordering —
   find the enforcing code and its tests.
3. Opt-in: with memory.enabled unset, zero memory I/O and zero prompt changes.
4. Job queue: exactly-once claim under duplicate triggers; idempotent enqueue key.
5. Redaction cannot be disabled by config.
6. Generated client files were produced by `bun run generate`, not hand-edited
   (check git show for the client commit touches only src/generated*).
Then TODO/README.md §5.1 generic checks. Numbered findings, BLOCKER/MINOR,
file:line. No edits.
```

## Deviation Log

| Task | Deviation | Reason |
|---|---|---|
