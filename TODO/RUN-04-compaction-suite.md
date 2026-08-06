# RUN-04: Staged Compaction Engine, Typed Checkpoints, Snapshots, Cache-Edit Microcompact

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superagent inline execution to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ad-hoc V2 compaction selection with the already-built staged planner (`@ultracode/context`), persist a typed `CompactionCheckpoint`, retain a toggleable full pre-compaction context snapshot in the artifact store, and add Anthropic cache-edit-aware microcompaction so cheap clearing no longer busts the provider prefix cache.

**Architecture:** The V2 compaction controller gains a stage pipeline (dedupe → artifact-preview replace → microcompact with protection tags → retoken → summarization) whose outputs are a durable typed checkpoint plus the rolling summary (summary remains the model-facing artifact; the checkpoint is its structured audit twin stored in the sidecar artifact store). Pre-compaction snapshots (opt-in) capture the full pre-compaction request context as a retention-class artifact. Where the provider supports server-side cache editing, microcompact issues cache edits instead of history mutation when safe; otherwise it falls back to today's mutation.

**Tech Stack:** Bun, TypeScript, Effect-TS; `@ultracode/context` planner; `@ultracode/schema` capability profiles (flag consumption only — full runtime wiring is RUN-05); sidecar artifact store (RUN-01 supervision).

**Audit basis:** §5.5/§12 (staged engine + checkpoints orphaned; cache-edit gap), §18-A1.3 + A7, TODO.md "toggleable context snapshots before compaction" and "Codex compaction conformance comparison".

## Global Constraints

`TODO/README.md` §2 verbatim, plus:

- **One compaction controller** (ULTRACODE.md §4): everything lives in `packages/core/src/session/compaction*.ts` + `@ultracode/context` planner stages. V1 `packages/opencode/src/session/compaction.ts` is frozen (bugfixes only).
- The model-facing transcript after compaction must round-trip through `to-llm-message.ts` unchanged in shape (`<conversation-checkpoint>` wrapper); the typed checkpoint is audit data, not injected text.
- Overflow semantics stay: preflight estimate → compact-if-needed; provider overflow → exactly one overflow-triggered compaction; second overflow terminal.
- Never fabricate: stages may drop/replace content but may not rewrite user text; the summarization seam remains injected.
- Provenance: the conformance strategy set is inspired by observed Codex behavior; it is reimplemented against your own invariants and needs a `docs/provenance/ledger.json` entry if you read `../codex` sources while designing it (reading is fine; recording is mandatory).
- Branch: `compaction-suite`.

## Orchestrator Brief

### Context Files (read in full before Task 1)

1. `packages/ultracode-context/src/planner/{types,threshold,protect,microCompact,compact}.ts` — the already-built stage engine; inventory every exported function and its exact signature (write them into the ledger before dispatching).
2. `packages/ultracode-context/README.md` and `src/compiler/{budget,types}.ts` — budget math (`allocateFlexible` 35/45/15/5).
3. `packages/core/src/session/compaction.ts`, `compaction-adapter.ts`, `compaction-summarize.ts` — current controller; the existing `CompactionCheckpoint` schema (13 fields incl. `workingSet`, `facts{confidence,trust}`, `tests`, `approvalState`, `agentLineage`, `worldStateBaseline`, `recentTailStartId`).
4. `packages/core/src/session/runner/llm.ts` (`TurnTransitionError` control flow) and `packages/core/src/session/history.ts` (compaction cutoff selection).
5. `packages/core/src/tool-output-store.ts` (content-addressed spill) and `crates/ultracode-events/src/artifacts.rs` (retention classes) — the snapshot destination.
6. `packages/llm/src/cache-policy.ts`, `packages/llm/src/protocols/anthropic-messages.ts` — existing breakpoint handling; where a cache-edit capability flag would attach.
7. `packages/ultracode-schema/src/capability/profile.ts` — the `caching` fields (RUN-05 consumes them fully; here you only read the flag if resolvable without a runtime dependency cycle).
8. Tests: `ls packages/core/test/session packages/ultracode-context/test`.

### Baselines

```bash
cd packages/core && bun test test/session 2>&1 | tail -5
cd packages/ultracode-context && bun test 2>&1 | tail -5
rg -n "CompactionCheckpoint|checkpointPrompt|parseCheckpoint" packages/core/src/session --include="*.ts" | head
rg -n "cache" packages/llm/src/protocols/anthropic-messages.ts | head
```

### Dispatch Order

1 → 6 sequential (Task 6 does Rust-free artifact writes through the RPC client; no cargo work here). Note: if RUN-01 is NOT done, the snapshot persistence task must run against an unsupervised client — in that case record a ledger deviation and gate Task 5's integration test on client availability rather than skipping it.

### Definition of Done

- [ ] A scripted 40-turn fixture conversation compacts through the new pipeline producing: (a) one durable compaction message whose summary exists, (b) one `CompactionCheckpoint` artifact in the store (retrievable by sha), (c) protection-tagged parts surviving intact, (d) total post-compaction tokens below the preflight budget.
- [ ] With `compaction.snapshot: true`, the artifact store additionally contains the full pre-compaction context JSON with retention class `session-audit`; with it false, no snapshot artifact.
- [ ] On a fake Anthropic route advertising cache-edit support, microcompact emits cache-edit operations instead of history mutation; on routes without support it mutates history exactly as today (flag-gated test both ways).
- [ ] The conformance scenario suite (Task 6) passes: overflow-once-then-terminal, protection invariants, tail keep ≈ `compaction.keep.tokens`, no summary fabrication (verbatim markers present for next-step quotes).
- [ ] `bun typecheck` green in `packages/core` and `packages/ultracode-context`.

---

### Task 1: Characterize the staged planner

**Files:**
- Test: `packages/ultracode-context/test/planner/characterization.test.ts`

**Interfaces:** Consumes all planner exports (ledger inventory). Produces: pinned stage-by-stage behavior: dedupe removes exact duplicates only; artifact-preview replaces only outputs above threshold with preview+ref; microCompact keeps last 5 compactable + last 2 user turns + tagged; retoken recomputes estimates; final output preserves message ordering and roles.

- [ ] **Step 1: Write pinning tests** for each stage with small handcrafted messages (use the `Planner` types verbatim — import from `@ultracode/context`).
- [ ] **Step 2:** Run `cd packages/ultracode-context && bun test test/planner/characterization.test.ts`. Violations → `.fails` + deviation log.
- [ ] **Step 3:** Commit — `test(ultracode-context): pin planner stage behavior before wiring`

### Task 2: Pipeline integration in the V2 controller

**Files:**
- Modify: `packages/core/src/session/compaction.ts`
- Modify: `packages/core/src/session/compaction-adapter.ts` (adapt history ↔ planner messages in both the select and render directions)
- Test: `packages/core/test/session/compaction-pipeline.test.ts`

**Interfaces:**
- Consumes: planner stages (Task 1 inventory); existing `compactIfNeeded`, `compactAfterOverflow`, `buildPrompt`, `select`.
- Produces: `CompactionPipeline.run(input): Effect<{summaryMessage; clearedPartIds; checkpoint: CompactionCheckpoint}>` — the controller's single entry; `compactIfNeeded` and overflow paths BOTH call it.

- [ ] **Step 1: Failing tests** — fixture history (30 messages incl. two identical tool outputs, one 60KB tool output, one protection-tagged part): pipeline dedupes, replaces the big output with preview+managed path, preserves the tagged part verbatim, emits a checkpoint whose `recentTailStartId` references an existing message id. Second test: given a preflight "needed" signal, `compactIfNeeded` routes through the pipeline exactly once.
- [ ] **Step 2–5:** run/fail → implement (keep `select`'s anchored summary as the summarization stage input; the pipeline feeds it the post-stage messages) → run/pass → typecheck.
- [ ] **Step 6: Commit** — `feat(core): run staged compaction pipeline in the V2 controller`

### Task 3: Typed checkpoint persistence in the artifact store

**Files:**
- Modify: `packages/core/src/session/compaction.ts` (`Compaction.Ended` projection path)
- Modify: `packages/opencode/src/agent/scheduler-service.ts` or the artifact-write seam you found in Context File 5 (choose the existing write path; do not create a second artifact client)
- Test: `packages/core/test/session/compaction-checkpoint-store.test.ts`

**Interfaces:**
- Consumes: Task 2 checkpoint; sidecar artifact RPC (verify method name: `rg -n "artifact" packages/ultracode-events-client/src/index.ts`).
- Produces: on `Compaction.Ended`, store `{ checkpoint, context_epoch, session_id, parent_compaction_sha? }` canonical JSON with retention class `session-audit`; the compaction message's durable metadata references the artifact sha (`checkpointSha`).

- [ ] **Step 1: Failing test** — run the pipeline against the fixture, assert an artifact exists whose parsed body round-trips through `parseCheckpoint`, and the message metadata carries `checkpointSha` equal to the stored sha.
- [ ] **Step 2–5:** run/fail → implement → run/pass → typecheck.
- [ ] **Step 6: Commit** — `feat(core): persist typed compaction checkpoints as session-audit artifacts`

### Task 4: Toggleable pre-compaction context snapshots

**Files:**
- Modify: config schema (`rg -l "compaction.buffer" packages/core packages/opencode` to find the home; add `compaction.snapshot: boolean = false`)
- Modify: `packages/core/src/session/compaction.ts`
- Test: `packages/core/test/session/compaction-snapshot.test.ts`

**Interfaces:** Produces: when enabled, before any stage mutation, persist the full pre-compaction provider-request context (`{ system, messages, tools }` JSON) as a `session-audit` artifact named in the `Compaction.Started` event metadata (`preCompactionSnapshotSha`). Failure to store the snapshot must NOT fail compaction (CONTEXT.md managed-output rule; record explicit loss in event metadata instead).

- [ ] **Step 1: Failing test** — enabled → artifact exists and contains the unmutated messages array (deep equal against fixture); simulated artifact-write failure → compaction still succeeds and `Compaction.Started` metadata carries `snapshotLost: true`.
- [ ] **Step 2–5:** run/fail → implement → run/pass → typecheck.
- [ ] **Step 6: Commit** — `feat(core): toggleable pre-compaction context snapshots`

### Task 5: Cache-edit-aware microcompact (provider-gated)

**Files:**
- Modify: `packages/core/src/session/compaction.ts` (microcompact branch)
- Modify: `packages/llm/src/cache-policy.ts` only if the route needs an explicit capability flag — first check what Context File 6 shows; the cleanest seam is a capability boolean carried with the resolved route/model, defaulting `false`
- Test: `packages/core/test/session/microcompact-cache-edit.test.ts`

**Interfaces:**
- Consumes: `Planner.microCompact` output (the set of parts cleared); route capability.
- Produces: when `cacheEdit: true` resolves for the current route+model: the controller emits `{ kind: "cache-edit", partIds }` alongside the cleared state so the next request can represent deletion provider-natively; when false: current mutation behavior, byte-identical. The durable history records the SAME cleared state either way (audit truth identical; only the wire representation differs).

- [ ] **Step 1: Failing test** — fake route (capability on): microcompact yields cache-edit ops and the next request shape matches the provider expectation you encode in the test; capability off: identical cleared state, zero cache-edit ops.
- [ ] **Step 2–5:** run/fail → implement → run/pass → typecheck both packages.
- [ ] **Step 6: Commit** — `feat(core): cache-edit-aware microcompaction`

### Task 6: Compaction conformance scenario suite

**Files:**
- Test: `packages/core/test/session/compaction-conformance.test.ts` (pure scenario driver)
- Create: `packages/core/test/session/fixtures/compaction/*.json` (scripted conversations)

**Interfaces:** Produces: five scenario fixtures as data + one driver, asserting:
1. Overflow exactly once, then terminal `TurnTransitionError` (second overflow never recompacts).
2. Tag protection: userAuthored/permissionOrConstraint/invokedSkill/currentTask/activeFailure parts always survive.
3. Tail-keep within ±10% of `compaction.keep.tokens` (4-chars/token estimate).
4. Summary contains at least one verbatim next-step quote from pre-compaction text when the next step was stated (fixture includes one explicitly).
5. No-cache-edit route → history mutation; with-cache-edit route → wire-level edits; durable state identical.

- [ ] **Step 1: Write fixtures + driver skeleton + failing run** — `cd packages/core && bun test test/session/compaction-conformance.test.ts`.
- [ ] **Step 2–4:** implement driver → green → typecheck.
- [ ] **Step 5: Commit** — `test(core): compaction conformance scenario suite`

### Task 7: Docs + ledger

- [ ] Update `packages/core/src/session/README`-adjacent docs if any (check), tick `TODO/README.md` §7 RUN-04 row + §8 ledger, add `docs/provenance/ledger.json` entry ONLY if anyone opened `../codex` during this run.
- [ ] Commit — `docs(compaction): staged pipeline, checkpoints, snapshots, cache-edit notes`

---

## Run-Level Review Prompt (dispatch after Task 7)

```
Review commits <hashes> implementing RUN-04 (opencode/TODO/RUN-04-compaction-suite.md).
Run-specific checks:
1. One controller: all compaction flows (preflight, overflow, explicit call)
   route through the new pipeline; grep for any remaining ad-hoc selection in
   compaction.ts that bypasses stage order.
2. Overflow-once invariant intact; second overflow terminal (find the test).
3. Durable truth identical across cache-edit vs mutation paths.
4. Snapshot artifacts honor retention and never gate compaction success.
5. Protection tags enumerated in protect.ts are the exhaustive set honored by
   tests (no tag honored in code but untested).
6. No V1 compaction mutation (frozen file untouched).
Then TODO/README.md §5.1 generic checks. Numbered findings, BLOCKER/MINOR,
file:line. No edits.
```

## Deviation Log

| Task | Deviation | Reason |
|---|---|---|
