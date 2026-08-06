# RUN-14: Daemon Workers — Attach/Detach, /goal, Heartbeats/Schedules, Bounded Autonomy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sessions outlive the client: a daemon worker process owns root session trees, supports attach/detach, durable `/goal` roots, sidecar-claimed heartbeat/cron schedules, and bounded autonomous mode with quality gates — all on one host, with leases and claims in the `ultracode-events` sidecar.

**Architecture:** `opencode serve --daemon` starts a `DaemonSupervisor` in the server process (sidecar owner + worker watchdog) and spawns one worker child process (`packages/opencode/src/daemon/worker.ts`) that owns all adopted root session trees. The worker is the *only* executor: the server wires `SessionExecution.noopLayer`, the worker wires the process-local `SessionExecutionLocal`. The worker reaches the sidecar through a JSON-RPC-over-stdio bridge to the supervisor, so the sidecar stays single-writer. Client attach/detach is transport-only: `sessions.events({after})` (existing durable SSE) replays + continues live; detaching never stops the worker. `/goal` is a durable sidecar record; the worker injects goal continuations at drain end until a `goal.complete` tool call. Schedules/heartbeats are sidecar `agent_jobs` ticks claimed-and-advanced before delivery, with deterministic prompt input ids for exactly-once delivery after crash. Autonomous mode wraps supervised runs with limits + quality gates (bounded 6KB output, workspace-hash skip) and journals verdicts; "a limit is not success".

**Tech Stack:** Bun, TypeScript, Effect-TS, Rust (cargo), Drizzle/SQLite (EventV2 + sidecar projections), newline-delimited JSON-RPC over stdio (sidecar + worker bridge), SSE (`sessions.events`).

**Audit basis:** §14 (Prime deep dive: worker/detach, goals, heartbeats/schedules, quality-gated autonomy), §18-A4 (worker daemonization over the sidecar), §20.3 (quality-gate deliverable checking), §22 (`/goal` → A4-dependent; heartbeats/schedules), TODO.md "Implement `/goal` as a durable goal/task entry point bound to the scheduler DAG".

## Global Constraints

All constraints in `TODO/README.md` §2 apply verbatim. In addition:

- **Single-host, multi-process.** Do NOT design multi-machine clustering or cross-process shared Session execution ownership. One daemon supervisor, one worker process, one sidecar, leases in the sidecar. If a task needs clustered semantics, STOP and record it as a follow-up in the run ledger — do not build it.
- **One executor per session.** In daemon mode the server process must never drain (wire `SessionExecution.noopLayer`); the worker process drains. A session with two live executors is a defect.
- **One writer to the sidecar.** The supervisor owns the single sidecar subprocess; the worker's `EventsClient` uses `EventsClient.fromTransport` over the IPC bridge. No second sidecar process, no direct worker→sidecar spawn.
- **No second claim store.** Claims/advance live only in the sidecar `agent_jobs`/`schedules` projection tables; TS code never writes journal files (`propose_commit` with idempotency keys only).
- **Exactly-once delivery via deterministic ids.** Every injected prompt (schedule tick, goal continuation) carries a deterministic `id` derived from the sidecar job (`tick:<schedule_id>:<seq>`, `goal:<goal_id>:<seq>`) and is admitted via `SessionV2.prompt({ id, ... })` whose idempotent admission reconciles redelivery. Duplicate visible prompts are a defect.
- **Limit is not success.** A run stopped by maxTokens/maxTurns/timeout/gate-retry-exhaustion never yields status `completed`, never completes a goal, and journals a limit verdict.
- **Additive, backwards-compatible Rust.** No changes to existing RPC semantics, envelopes, or table shapes; additions only. Rust must pass `cargo test -p ultracode-events` and `cargo clippy -p ultracode-events -- -D warnings` from repo root. New projection tables are created `IF NOT EXISTS` and added to the `rebuild` delete list.
- **Provenance.** The design in this run is *reimplemented from invariants* — not copied — from reading `../prime-agent` sources (`packages/coding-agent/docs/long-running-agents.md`, `src/core/goals.ts`, `src/core/autonomous.ts`, pinned commit `c22549a3`). Task 10 MUST add `docs/provenance/ledger.json` + `docs/provenance/sources.json` entries (schema in `scripts/provenance/validate.ts`) with `treatment: "reimplement"` and validate with `bun run scripts/provenance/validate.ts`. If any plan excerpt resembles prime source text, rewrite it.
- **Branch:** `daemon-workers`.

## Orchestrator Brief

### Context Files (read in full before dispatching Task 1)

1. `packages/core/src/session/execution.ts` + `execution/local.ts` — `SessionExecution` interface, `supervise`, `noopLayer`, process-local drain.
2. `packages/core/src/session/run-coordinator.ts` — `Coordinator.make` run/wake/interrupt/active coalescing.
3. `packages/core/src/session.ts` — `SessionV2.Service`: `create`, `prompt({id, sessionID, prompt, delivery, resume})`, `events`, `history`, `active`, `resume`, `interrupt`.
4. `packages/core/src/session/input.ts` — `SessionInput.admit` idempotency by message id (the exactly-once primitive).
5. `packages/core/src/event.ts` — `EventV2` durable replay + owner `claim`; `durable({aggregateID, after})` stream.
6. `packages/core/src/session/runner/index.ts` + `runner/llm.ts` — `Limits {maxTokens, maxTurns}`, usage accounting, budget_exhausted.
7. `packages/opencode/src/sync/README.md` — one-writer event sourcing.
8. `packages/ultracode-events-client/src/index.ts` — `EventsClient.start`, `EventsClient.fromTransport`, `SidecarTransport` (`(method, params) => Promise<unknown>`).
9. `crates/ultracode-events/src/{event,effect,rpc,projections}.rs` — EventKind registry, effect ledger, RPC dispatch, `memory_jobs` once-claim pattern, `worktree_leases`.
10. `packages/opencode/src/cli/cmd/{serve,attach,run}.ts` + `cli/network.ts` — CLI surfaces.
11. `packages/opencode/src/server/routes/instance/httpapi/server.ts` (lines ~300–320) — the single `SessionExecution.node + SessionExecutionLocal.node` wiring point.
12. `packages/server/src/handlers/session.ts` + `packages/protocol/src/groups/session.ts` + `packages/protocol/src/api.ts` — V2 protocol group + handlers; `session.events` / `session.history`.
13. `packages/core/src/background-job.ts` — long-lived fiber service pattern (reference for the supervisor lifecycle).
14. `packages/opencode/src/agent/scheduler.ts` — `createWorktreeLeaseAdapter` lease naming `scheduler-<hex(root)>-<hex(task)>`; the effect-ledger/lease idioms to reuse for worker ownership leases.
15. `../prime-agent/packages/coding-agent/docs/long-running-agents.md` + `src/core/{goals,autonomous}.ts` — DESIGN ONLY; reimplement from invariants (provenance in Task 10).

### Baselines (record before Task 1)

```bash
cd packages/opencode && bun test test/daemon 2>&1 | tail -5   # directory does not exist yet; record "no daemon tests"
cd packages/opencode && bun typecheck 2>&1 | tail -5
cd packages/ultracode-events-client && bun test 2>&1 | tail -5
cargo test -p ultracode-events 2>&1 | tail -5
which sidecar; echo $ULTRACODE_EVENTS_SIDECAR_BIN
```

### Dispatch Order

Tasks 1 → 10 strictly sequential. Task 1 is characterization + pinning only (no product code). Tasks 2 and 3 are the two biggest; do not start Task 3 until Task 2's Rust is merged and its `Interfaces: Produces` verified.

### Definition of Done (verify each with a command you ran)

- [ ] `opencode serve --daemon` runs a worker child; `session.active` served by the daemon server returns an empty set while the worker drains the same session (one-executor invariant, via `packages/opencode/test/daemon/one-executor.test.ts`).
- [ ] `claim_tick` returns `{ job_id: "schedule:<id>:<seq>", data.input_id: "tick:<id>:<seq>" }`, advances `next_due`/`tick_seq`, and `cargo test -p ultracode-events` is green.
- [ ] Crash matrix: a worker killed at each of the 5 failure points (in `packages/opencode/test/daemon/CRASH-MATRIX.md`) leaves zero duplicate visible prompts and zero lost ticks; the matrix is a checked-in md with one checklist row per failure point.
- [ ] Goal-until-complete test passes: continuations injected until `goal.complete`, then stop; budget-exhaustion test marks the goal `budget_limited`, never `complete`.
- [ ] Attach-mid-run test: attach while the worker is mid-drain replays `after` then continues live with no gaps.
- [ ] Tick coalescing test: a schedule overdue by N periods delivers exactly one tick (seq +1) and no backlog.
- [ ] "Limit is not success": gate-fail + token limit → status `budget_exhausted`, goal not complete, verdict `limit_reached` journaled.
- [ ] `bun typecheck` passes in `packages/core`, `packages/opencode`, `packages/ultracode-events-client`, `packages/server`, `packages/client`, `packages/protocol`.
- [ ] `bun run scripts/provenance/validate.ts` passes (ledger + sources entries from Task 10).
- [ ] Run ledger row appended (§8 of TODO/README.md).

---

### Task 1: Characterization and pinning tests

**Files:**
- Create: `packages/opencode/test/daemon/INVENTORY.md`
- Create: `packages/core/test/session/supervise-pin.test.ts`
- Create: `packages/core/test/session/run-coordinator-pin.test.ts`
- Create: `packages/core/test/event-durable-pin.test.ts`
- Create: `packages/opencode/test/daemon/session-events-pin.test.ts`
- Test: each file above (bun:test; Rust none in this task)

**Interfaces:**
- Consumes: the Context Files above (read in full, verify every path exists, record drift).
- Produces: pinned contract facts (exact signatures) that later tasks consume — `SessionExecution.supervise(input: SupervisionInput)` status/usage shape; `Coordinator.make` run/wake/interrupt semantics; `EventV2.durable({aggregateID, after})` replay-then-live; `SessionV2.prompt({id,...})` idempotent admission; `session.events`/`session.history` wire shapes; `EventsClient.fromTransport`; sidecar `memory_jobs` claim pattern + `worktree_leases`; CLI `serve`/`attach` surface. Also produce the daemon-mode wiring point map (which server files mount `SessionExecutionLocal`, how `Server.listen(opts)` threads options, where the protocol `Api` is mounted) recorded in INVENTORY.md.

- [ ] **Step 1: Read + inventory.** Read every Context File in full. Verify each path with `test -f <path>`; find successors for anything that moved (`rg`). Record the verified-path table and every drift correction in `packages/opencode/test/daemon/INVENTORY.md` (a checked-in reference the orchestrator uses when dispatching later tasks). Also record: (a) the exact lines in `packages/opencode/src/server/routes/instance/httpapi/server.ts` and `packages/server/src/routes.ts` that wire `SessionExecutionLocal`; (b) the `Server.listen`/`ListenOptions` shape in `packages/opencode/src/server/server.ts`; (c) how `session.events`/`session.history` handlers are reached (protocol `Api` mount); (d) the `memory_jobs` once-claim SQL (`projections.rs` `claim_memory_job`, `rebuild` reset of `running`).

- [ ] **Step 2: Pin `SessionExecution.supervise`** — `packages/core/test/session/supervise-pin.test.ts` (real `SessionRunCoordinator`, tmpdir, `Layer` with a scripted drain that exits with a given `RunResult`):

```ts
import { describe, test, expect } from "bun:test"
import { Effect, Layer, RunResult as _ } from "effect"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionExecution } from "@opencode-ai/core/session/execution"

const scripted = (drain: () => Effect.Effect<{ status: "completed" | "budget_exhausted"; usage: { tokens: number; turns: number }; changedPaths: string[] }, never>) =>
  Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const coordinator = yield* SessionRunCoordinator.make<string, never, { status: string; usage: { tokens: number; turns: number }; changedPaths: string[] }, void>({
        drain: () => drain(),
      })
      return SessionExecution.Service.of({
        active: coordinator.active,
        resume: (id) => coordinator.run(id).pipe(Effect.asVoid),
        wake: coordinator.wake,
        interrupt: coordinator.interrupt,
        supervise: (input) => SessionExecution.supervise(coordinator as never, input),
      })
    }),
  )

describe("SessionExecution.supervise pin", () => {
  test("maps a completed drain to TerminalRunResult with usage", async () => {
    const result = await Effect.runPromise(
      SessionExecution.supervise(undefined as never, { sessionID: "ses_1" as never, maxTokens: 10, maxTurns: 5, timeoutMs: 1000 }).pipe(
        Effect.provide(scripted(() => Effect.succeed({ status: "completed", usage: { tokens: 4, turns: 2 }, changedPaths: ["a.ts"] }))),
      ),
    )
    expect(result.status).toBe("completed")
    expect(result.usage).toEqual({ tokens: 4, turns: 2, elapsedMs: expect.any(Number) })
    expect(result.changedPaths).toEqual(["a.ts"])
  })
})
```
**Adjust the `SessionExecution.supervise`/coordinator wiring to the real signatures you read in Context Files 1–2; the test must exercise the real `supervise` function with a real coordinator whose drain returns a canned `RunResult`, and assert status/usage mapping for at least `completed`, `timed_out` (via a drain that never completes + small `timeoutMs`), and `cancelled` (interrupt the drain).** Run: `cd packages/core && bun test test/session/supervise-pin.test.ts`. Expected: PASS after you adapt to the real `RunResult`/`Limits` types. If `session` test dir does not exist yet, create it.

- [ ] **Step 3: Pin `Coordinator` wake coalescing** — `packages/core/test/session/run-coordinator-pin.test.ts`: a coordinator whose drain counts invocations and returns after the first; call `run(key)` then `wake(key)` twice before the drain settles; assert the drain runs again exactly once (coalescing) and `active` reflects the key while running. Follow the `SessionRunCoordinator.make` usage in `execution/local.ts`. Run: `cd packages/core && bun test test/session/run-coordinator-pin.test.ts`. Expected: PASS.

- [ ] **Step 4: Pin `EventV2` durable replay + owner claim** — `packages/core/test/event-durable-pin.test.ts` (use the real `EventV2.layerWith` + tmpdir SQLite; follow existing `packages/core/test` event tests for the DB layer setup): publish two durable events for one aggregate, subscribe `durable({aggregateID, after: 0})` and assert both arrive then live continuation arrives after a third publish; assert `replay` with `strictOwner`/`ownerID` claims the aggregate sequence owner and a mismatched owner dies. Run: `cd packages/core && bun test test/event-durable-pin.test.ts`. Expected: PASS.

- [ ] **Step 5: Pin the `sessions.events` HTTP surface** — `packages/opencode/test/daemon/session-events-pin.test.ts`: build the embedded server (`createEmbeddedRoutes` from `@opencode-ai/server/routes`), create a session, admit two prompts, drive `GET /api/session/:id/event?after=<seq>` as an SSE fetch and assert the durable replay events arrive, and `GET /api/session/:id/history?after=<seq>&limit=1` returns `hasMore` correctly. Follow the SDK client usage in `packages/opencode/test` (the generated client `client.session.events({sessionID, after})`). Run: `cd packages/opencode && bun test test/daemon/session-events-pin.test.ts`. Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
cd packages/core && bun typecheck
cd packages/opencode && bun typecheck
git add packages/opencode/test/daemon/INVENTORY.md packages/core/test/session/supervise-pin.test.ts packages/core/test/session/run-coordinator-pin.test.ts packages/core/test/event-durable-pin.test.ts packages/opencode/test/daemon/session-events-pin.test.ts
git commit -m "test(core): pin session execution, coordinator, and durable event contracts"
```

---

### Task 2: Sidecar job-table generalization, schedules, worker leases, goals (Rust)

**Files:**
- Create: `crates/ultracode-events/src/cron.rs`
- Modify: `crates/ultracode-events/src/event.rs` (additive EventKind variants)
- Modify: `crates/ultracode-events/src/projections.rs` (new tables + claim/advance/lease/goal/gate methods + rebuild delete list)
- Modify: `crates/ultracode-events/src/rpc.rs` (new RPC methods + dispatch arms)
- Modify: `crates/ultracode-events/src/lib.rs` (export `cron`)
- Test: `crates/ultracode-events/src/cron.rs` (unit tests) + `crates/ultracode-events/src/rpc.rs` (RPC tests)

**Interfaces:**
- Consumes: `EventKind` serde tag/rename conventions, `propose_commit` idempotency, `ProjectionStore` pattern from `memory_jobs` (`claim_memory_job`, `complete_memory_job`, `rebuild` reset of `running`), RPC dispatch `handle_request`/`dispatch` (`rpc.rs`), workspace scoping (`root_matches`, `is_absolute_workspace`).
- Produces:
  - `crates/ultracode-events/src/cron.rs`: `validate_cron(expr: &str) -> Result<(), String>`, `cron_next(expr: &str, after_ms: u64) -> Result<u64, String>` — 5-field cron (`min hour dom month dow`), fields `*` or comma-separated numbers; `cron_next` returns the first strict future match in UTC epoch ms.
  - New `EventKind` variants (kebab-case): `ScheduleCreated { schedule_id, session_id, workspace_directory, cron_expr, prompt, delivery }`, `ScheduleCancelled { schedule_id, reason }`, `WorkerRegistered { worker_id, host, pid, registered_at }`, `WorkerLeased { worker_id, root_session_id, workspace_directory, task_id }`, `WorkerReleased { worker_id, root_session_id, reason }`, `GoalCreated { goal_id, session_id, workspace_directory, objective, token_budget }`, `GoalUsageRecorded { goal_id, session_id, tokens, turns, elapsed_ms, at_ms }`, `GoalCompleted { goal_id, session_id, summary }`, `AgentJobCompleted { job_id, kind }`, `AgentJobFailed { job_id, kind, reason }`, `AutonomyGateVerdict { session_id, command, attempt, passed, rerun_skipped, workspace_hash, exit_text, output, at_ms }`.
  - `ProjectionStore` methods: `insert_schedule(&mut self, schedule_id, session_id, workspace_directory, cron_expr, prompt, delivery) -> Result<u64>` (returns `cron_next`); `list_schedules(&mut self, workspace_directory) -> Result<Vec<ScheduleRow>>`; `delete_schedule(&mut self, schedule_id) -> Result<bool>`; `claim_tick(&mut self, worker_id, workspace_directory, now_ms) -> Result<Option<ClaimedTick>>`; `complete_job(&mut self, job_id) -> Result<bool>`; `fail_job(&mut self, job_id, reason) -> Result<bool>`; `lease_row(&mut self, worker_id, root_session_id, workspace_directory, task_id) -> Result<()>`; `heartbeat(&mut self, worker_id, owned: &[LeaseOwned], at_ms) -> Result<()>`; `list_leases(&mut self, workspace_directory) -> Result<Vec<WorkerLeaseRow>>`; `stale_leases(&mut self, workspace_directory, fence_ms, now_ms) -> Result<Vec<WorkerLeaseRow>>`; `delete_lease(&mut self, worker_id, root_session_id) -> Result<()>`; `insert_goal(&mut self, goal_id, session_id, workspace_directory, objective, token_budget) -> Result<()>`; `get_goal(&mut self, goal_id) -> Result<Option<GoalRow>>`; `list_goals(&mut self, workspace_directory, status) -> Result<Vec<GoalRow>>`; `accumulate_goal_usage(&mut self, goal_id, tokens, turns, elapsed_ms) -> Result<()>`; `complete_goal_row(&mut self, goal_id, summary) -> Result<bool>`; `insert_gate_verdict(&mut self, verdict: &GateVerdictRow) -> Result<()>`; `list_gate_verdicts(&mut self, session_id, limit) -> Result<Vec<GateVerdictRow>>`.
  - Structs: `ClaimedTick { job_id: String, kind: String, data: serde_json::Value, seq: u64 }`, `ScheduleRow { schedule_id, session_id, workspace_directory, cron_expr, prompt, delivery, enabled, next_due_ms, tick_seq }`, `WorkerLeaseRow { worker_id, root_session_id, workspace_directory, heartbeat_at }`, `LeaseOwned { root_session_id, workspace_directory }`, `GoalRow { goal_id, session_id, workspace_directory, objective, token_budget, status, tokens_used, turns_used, elapsed_ms, created_at, completed_at, completion_summary }`, `GateVerdictRow { session_id, command, attempt, passed, rerun_skipped, workspace_hash, exit_text, output, at_ms }`.
  - New RPC methods: `create_schedule`, `list_schedules`, `cancel_schedule`, `claim_tick`, `complete_job`, `fail_job`, `register_worker`, `lease_root`, `release_root`, `heartbeat`, `list_leases`, `create_goal`, `list_goals`, `get_goal`, `record_goal_usage`, `complete_goal`, `list_gate_verdicts`. Params shapes and idempotency keys: `create_schedule`/`create_goal`/`register_worker`/`lease_root` take `key`; `complete_job`/`fail_job` take `key` (worker proposes `job:complete:<job_id>` / `job:fail:<job_id>`); `record_goal_usage` takes `key` (`goal-usage:<goal_id>:<seq>`, monotonic `seq` by worker); `complete_goal` takes `key` (`goal-complete:<goal_id>`). All mutations journal via `propose_commit` then index the returned record; claims/advance mutate projection tables directly (like `claim_memory_job`).

- [ ] **Step 1: Write the failing cron tests** — `crates/ultracode-events/src/cron.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_garbage() {
        assert!(validate_cron("not a cron").is_err());
        assert!(validate_cron("* * * *").is_err());
        assert!(validate_cron("* * * * *").is_ok());
        assert!(validate_cron("0 9 * * 1-5").is_err()); // ranges unsupported this run
    }

    #[test]
    fn cron_next_every_minute() {
        let after = 1_700_000_000_000u64;
        let next = cron_next("* * * * *", after).unwrap();
        assert!(next > after);
        assert!(next - after <= 60_000);
    }

    #[test]
    fn cron_next_skips_to_matching_field() {
        // "0 9 * * *" → next 09:00 UTC strictly after `after`.
        let after = 1_700_000_000_000u64;
        let next = cron_next("0 9 * * *", after).unwrap();
        let dt = chrono::DateTime::<chrono::Utc>::from_timestamp((next / 1000) as i64, 0).unwrap();
        assert_eq!(dt.hour(), 9);
        assert_eq!(dt.minute(), 0);
    }
}
```
(Add `chrono` as a dev-dependency in `crates/ultracode-events/Cargo.toml`; the crate already builds on `serde_json`/`rusqlite`.)

- [ ] **Step 2: Run it, watch it fail** — `cargo test -p ultracode-events cron_next_skips_to_matching_field`. Expected: FAIL — module `cron` not found.

- [ ] **Step 3: Implement `cron.rs`** — `validate_cron` parses 5 whitespace-separated fields into `[Vec<u32>; 5]` (each `*` or comma-list of `0..` bounds per field: min 0–59, hour 0–23, dom 1–31, month 1–12, dow 0–6); `cron_next(expr, after_ms)` walks candidate timestamps minute-by-minute (bounded: bail with an error if no match within 5 years) in UTC, returning the first minute whose fields all match, strictly after `after_ms`. Export from `lib.rs` (`pub mod cron;`).

- [ ] **Step 4: Run, watch pass** — `cargo test -p ultracode-events cron`. Expected: PASS.

- [ ] **Step 5: Write the failing RPC tests for schedules** — append to `rpc.rs` tests (reuse the existing `dirs`, `req`, `handle_request` helpers):

```rust
#[test]
fn schedule_claims_once_and_advances_next_due() {
    let (journal, db, blobs) = dirs("sched-claim");
    let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
    let create = handle_request(
        &mut state,
        &req(1, "create_schedule", json!({
            "key": "sched:create:a", "schedule_id": "sched-a", "session_id": "ses_root",
            "workspace_directory": "/repo", "cron_expr": "* * * * *",
            "prompt": "check the deployment", "delivery": "steer"
        })),
    );
    assert!(create.error.is_none(), "create failed: {:?}", create.error);

    // claim with an explicit now (projections API) so the tick is due immediately.
    let claimed = state.projections.claim_tick("worker-1", "/repo", 1_700_000_000_000).unwrap().unwrap();
    assert_eq!(claimed.job_id, "schedule:sched-a:1");
    assert_eq!(claimed.data["input_id"], "tick:schedule:sched-a:1");
    assert_eq!(claimed.data["prompt"], "check the deployment");

    // claim-and-advance: the same schedule is not due again at the same now.
    assert!(state.projections.claim_tick("worker-1", "/repo", 1_700_000_000_000).unwrap().is_none());

    // complete the job; a second complete is a no-op (idempotent).
    let done = handle_request(&mut state, &req(2, "complete_job", json!({
        "key": "job:complete:schedule:sched-a:1", "job_id": "schedule:sched-a:1", "workspace_directory": "/repo"
    })));
    assert!(done.error.is_none());
    assert!(handle_request(&mut state, &req(3, "complete_job", json!({
        "key": "job:complete:schedule:sched-a:1", "job_id": "schedule:sched-a:1", "workspace_directory": "/repo"
    })))
    .result
    .unwrap()["duplicate"] == json!(true));
    let _ = std::fs::remove_dir_all(journal.parent().unwrap());
}

#[test]
fn missed_ticks_coalesce_to_one_advance() {
    let (journal, db, blobs) = dirs("sched-coalesce");
    let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
    handle_request(&mut state, &req(1, "create_schedule", json!({
        "key": "sched:create:b", "schedule_id": "sched-b", "session_id": "ses_root",
        "workspace_directory": "/repo", "cron_expr": "*/5 * * * *",
        "prompt": "tick", "delivery": "steer"
    })));
    // Pretend 40 minutes passed since the schedule's first due moment.
    let first = 1_700_000_000_000u64;
    let later = first + 40 * 60_000;
    let claimed = state.projections.claim_tick("worker-1", "/repo", later).unwrap().unwrap();
    // Exactly one tick, sequence starts at 1, next_due jumps forward (no backlog rows).
    assert_eq!(claimed.seq, 1);
    assert_eq!(state.projections.list_schedules("/repo").unwrap()[0].next_due_ms, later + 5 * 60_000);
    let _ = std::fs::remove_dir_all(journal.parent().unwrap());
}
```

- [ ] **Step 6: Run, watch them fail** — `cargo test -p ultracode-events schedule_claims_once_and_advances_next_due`. Expected: FAIL — unknown method `create_schedule`.

- [ ] **Step 7: Implement projections + RPC** — add the five tables to `init` (all `CREATE TABLE IF NOT EXISTS`, snake_case, add every table name to the `rebuild` delete batch): `agent_jobs(job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', failure_reason TEXT, workspace_directory TEXT, claimed_by TEXT, claimed_at INTEGER, created_at INTEGER NOT NULL)`, `schedules(schedule_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_directory TEXT NOT NULL, cron_expr TEXT NOT NULL, prompt TEXT NOT NULL, delivery TEXT NOT NULL, enabled INTEGER NOT NULL, next_due_ms INTEGER NOT NULL, tick_seq INTEGER NOT NULL DEFAULT 0)`, `worker_leases(worker_id TEXT NOT NULL, root_session_id TEXT NOT NULL, workspace_directory TEXT NOT NULL, heartbeat_at INTEGER NOT NULL, PRIMARY KEY(worker_id, root_session_id))`, `goals(goal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, workspace_directory TEXT NOT NULL, objective TEXT NOT NULL, token_budget INTEGER, status TEXT NOT NULL DEFAULT 'active', tokens_used INTEGER NOT NULL DEFAULT 0, turns_used INTEGER NOT NULL DEFAULT 0, elapsed_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, completed_at INTEGER, completion_summary TEXT)`, `gate_verdicts(session_id TEXT NOT NULL, command TEXT NOT NULL, attempt INTEGER NOT NULL, passed INTEGER NOT NULL, rerun_skipped INTEGER NOT NULL, workspace_hash TEXT NOT NULL, exit_text TEXT NOT NULL, output TEXT NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY(session_id, command, attempt))`. `rebuild` resets `agent_jobs` rows `SET status = 'pending' WHERE status = 'running'` (same as memory_jobs). `claim_tick` runs a single transaction: select the first enabled schedule with `workspace_directory = ? AND next_due_ms <= ?` ORDER BY `next_due_ms ASC` LIMIT 1; compute `seq = tick_seq + 1`, `job_id = format!("schedule:{}:{}", schedule_id, seq)`, `input_id = format!("tick:{}:{}", schedule_id, seq)`; `INSERT INTO agent_jobs (job_id, kind, data, status, workspace_directory, claimed_by, claimed_at, created_at) VALUES (job_id, 'schedule-tick', json!({schedule_id, tick_seq: seq, session_id, prompt, delivery, input_id}), 'running', workspace_directory, worker_id, now_ms, now_ms)` (ignore-if-exists: if the job row already exists because a previous claim left it `pending` after a rebuild, return that existing job instead of re-advancing); then `UPDATE schedules SET tick_seq = seq, next_due_ms = cron_next(cron_expr, now_ms)`; return the job. `complete_job`/`fail_job` run `UPDATE agent_jobs SET status='completed'/'failed', failure_reason=? WHERE job_id=?` and return `rows_affected > 0`. Event projection (`index_record`): `ScheduleCreated` → `insert_schedule` (compute `next_due_ms = cron_next(cron_expr, now_ms)`); `ScheduleCancelled` → `delete_schedule` + fail pending `schedule:%` jobs for it; `WorkerRegistered` → no-op on tables (identity journaled); `WorkerLeased` → `lease_row`; `WorkerReleased` → `delete_lease`; `GoalCreated` → `insert_goal`; `GoalUsageRecorded` → `accumulate_goal_usage`; `GoalCompleted` → `complete_goal_row`; `AgentJobCompleted`/`AgentJobFailed` → set `agent_jobs` status; `AutonomyGateVerdict` → `insert_gate_verdict`. RPC dispatch arms: `create_schedule`, `list_schedules`, `cancel_schedule` (journal `schedule-cancelled`), `claim_tick` (worker_id + workspace_directory; workspace must be absolute; returns `ClaimedTick` or `null`), `complete_job`/`fail_job` (journal `agent-job-completed`/`agent-job-failed`; a job that is not `running` rejects with `"job is not running"`), `register_worker` (journal `worker-registered`), `lease_root` (journal `worker-leased`), `release_root` (journal `worker-released`), `heartbeat` (projection-only `UPDATE worker_leases SET heartbeat_at = ?` for each owned `(root_session_id, workspace_directory)` row; no journal event — operational state), `list_leases`, `create_goal` (validate objective non-empty ≤4000 chars, budget positive int if present; journal `goal-created`), `list_goals`, `get_goal`, `record_goal_usage` (journal `goal-usage-recorded`; validates goal exists and status != complete), `complete_goal` (journal `goal-completed`; validates goal exists and status is active/paused), `list_gate_verdicts`.

- [ ] **Step 8: Run, watch pass** — `cargo test -p ultracode-events`. Then `cargo clippy -p ultracode-events -- -D warnings`.

- [ ] **Step 9: Commit**

```bash
git add crates/ultracode-events/src/cron.rs crates/ultracode-events/src/event.rs crates/ultracode-events/src/projections.rs crates/ultracode-events/src/rpc.rs crates/ultracode-events/src/lib.rs crates/ultracode-events/Cargo.toml crates/ultracode-events/Cargo.lock
git commit -m "feat(ultracode-events): agent_jobs schedules worker leases goals and gate verdicts"
```

---

### Task 3: Worker process model, supervisor, leases, fencing, adoption, idle eviction

**Files:**
- Create: `packages/opencode/src/daemon/ipc.ts` (worker↔supervisor JSON-RPC-over-stdio bridge)
- Create: `packages/opencode/src/daemon/worker.ts` (worker entry: `runWorker`)
- Create: `packages/opencode/src/daemon/supervisor.ts` (`DaemonSupervisor` service + `spawnWorker`/`watchWorker`/`adoptOrphans`)
- Create: `packages/opencode/src/daemon/types.ts` (shared `WorkerArgs`, `WorkerDeps`, `LeaseOwned`, `Job` types)
- Create: `packages/opencode/test/daemon/ipc.test.ts`
- Create: `packages/opencode/test/daemon/worker.test.ts`
- Create: `packages/opencode/test/daemon/supervisor.test.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts` (daemon-mode wiring: `SessionExecution.noopLayer` + `DaemonSupervisor.node`)
- Modify: `packages/opencode/src/server/server.ts` (`ListenOptions.daemon`, thread through)

**Interfaces:**
- Consumes: `SessionExecution` + `SessionExecutionLocal` + `noopLayer` (Task 1 pins), `EventsClient.fromTransport` + `SidecarTransport` (Context File 8), sidecar RPCs from Task 2, `AppLayer` (`packages/opencode/src/effect/app-runtime.ts`), `SessionV2.list`/`prompt`/`events` (Context File 3), `EventV2.durable` (Context File 5).
- Produces:
  - `daemon/types.ts`: `WorkerArgs { workerId: string; directory: string; workspaceDirectory: string; leaseFenceMs: number; heartbeatMs: number; tickPollMs: number; idleGraceMs: number }`; `WorkerDeps { args: WorkerArgs; transport: SidecarTransport; sessionExecution?: Layer.Layer<SessionExecution.Service, never, never> }` (defaults to `SessionExecutionLocal.node`; tests inject a scripted layer); `WorkerHandle { stop(): Promise<void> }`; `LeaseOwned { rootSessionId: string; workspaceDirectory: string }`; `Job { jobId: string; kind: string; data: Record<string, unknown>; seq: number }`.
  - `daemon/ipc.ts`: parent side `spawnBridge(child: Subprocess, sidecar: EventsClient): { stop(): void }` — forwards `{id, method, params}` from child stdout to `sidecar`, writes `{id, result}` or `{id, error}` to child stdin; child side `ipcTransport(): SidecarTransport` — writes `{id, method, params}\n` to `process.stdout` (Bun fd 1) and resolves the matching `{id, result|error}` read from `process.stdin`. Both sides bounded: ignore messages with unknown id, error on stdout close.
  - `daemon/worker.ts`: `parseWorkerArgs(argv: string[]): WorkerArgs` (flags `--worker-id`, `--dir`, `--workspace-directory`, `--lease-fence-ms`, `--heartbeat-ms`, `--tick-poll-ms`, `--idle-grace-ms`); `export async function runWorker(deps: WorkerDeps): Promise<WorkerHandle>` — builds the runtime (`ManagedRuntime.make(AppLayer, { memoMap })` with `deps.sessionExecution ?? SessionExecutionLocal.node` swapped in place of the default), registers the worker (`register_worker`, key `worker:<workerId>`), lists candidate root sessions (`SessionV2.list({ directory, order: "asc" })` in the workspace), for each session not freshly leased adopts it (`lease_root`, key `lease:<rootSessionId>`), subscribes to `EventV2.durable({aggregateID, after: 0})` → on `SessionEvent.PromptAdmitted` for the owned session calls `SessionExecution.wake`; then runs three loops: scheduler (Task 6), heartbeat (`heartbeat({ workerId, owned, atMs })` every `heartbeatMs`), idleness (release lease + drop the in-memory coordinator entry for a session idle longer than `idleGraceMs` with no active goal and no enabled schedules); on `SIGTERM`/`SIGINT` releases all leases (`release_root`) and exits 0. Adopts only sessions whose sidecar lease is absent or stale (`stale_leases(workspaceDirectory, leaseFenceMs, now)`). Returns a `WorkerHandle` whose `stop()` releases all leases, stops the loops, and disposes the runtime.
  - `daemon/supervisor.ts`: `DaemonSupervisor.Service` (Context.Service) with `start(): Effect<void>`, `status(): Effect<DaemonStatus>`, `spawnWorker(): Effect<void>`, `stop(): Effect<void>`; owns the sidecar `startSupervised` client (RUN-01), spawns the worker child via `Bun.spawn([process.execPath, <worker entry>, ...flags], { stdin: "pipe", stdout: "pipe" })`, attaches `spawnBridge`, watches child exit: on non-graceful exit (no released leases) respawn with backoff `[250, 1000, 5000]`; `DaemonStatus { workerId, workerAlive, pid, leases, schedules, goals }`. Exports `node` (a scoped layer: starts the sidecar, spawns the worker, finalizer stops both).
- Note: worker child entry resolution — the worker entry is `packages/opencode/src/daemon/worker.ts`; the supervisor spawns it with `process.execPath` (bun) and the absolute path from `import.meta.url`-relative resolution. Record the exact resolved entry in INVENTORY.md during Task 1 if needed.

- [ ] **Step 1: Write the failing IPC test** — `packages/opencode/test/daemon/ipc.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { spawn } from "bun"
import { EventsClient } from "@opencode-ai/events-client"

describe("worker IPC bridge", () => {
  test("forwards a sidecar call through a spawned child and back", async () => {
    const child = spawn({
      cmd: [process.execPath, new URL("./fixtures/ipc-echo.ts", import.meta.url).pathname],
      stdout: "pipe",
      stdin: "pipe",
    })
    const pending = new Map<number, (value: unknown) => void>()
    const sidecar: SidecarTransport = async (method, params) => {
      // The bridge (parent side) is what routes child->sidecar; here we emulate
      // the supervisor's sidecar with an echo that answers ping.
      if (method === "ping") return { ok: true }
      throw new Error(`unexpected ${method}`)
    }
    // parent-side bridge from ipc.ts against this child
    const bridge = spawnBridge(child, EventsClient.fromTransport(sidecar))
    const client = EventsClient.fromTransport(ipcTransport())
    expect(await client.ping()).toEqual({ ok: true })
    bridge.stop()
    child.kill()
  })
})
```
(The fixture `test/daemon/fixtures/ipc-echo.ts` runs `ipcTransport()` and answers `ping` through its own transport; the test proves both ends of the bridge speak the ndjson contract. Adjust `spawnBridge`/`ipcTransport` names to the real exported names.) Run: `cd packages/opencode && bun test test/daemon/ipc.test.ts`. Expected: FAIL — module `../src/daemon/ipc` missing.

- [ ] **Step 2: Implement `daemon/ipc.ts`** — parent `spawnBridge(child, sidecar)`: read child stdout lines; for each `{id, method, params}` call `sidecar` via the raw method (`(sidecar as unknown as { [m: string]: (p: unknown) => Promise<unknown> })` — or add a package-private `call` accessor in the EventsClient if cleaner; do not change the public surface); write `{id, result}` or `{id, error}` to child stdin. Child `ipcTransport()`: `process.stdin` reader accumulating lines; `process.stdout.write(JSON.stringify({id, method, params}) + "\n")`; maintain a `Map<number, Deferred>`; respond to `SIGTERM` by resolving pending calls with an error. Follow the ndjson pattern from `EventsClient.callDirect` (Context File 8).

- [ ] **Step 3: Write the failing worker test** — `packages/opencode/test/daemon/worker.test.ts` (real sidecar binary via `resolveSidecarBin`, tmp dirs, scripted `SessionExecution` layer so no provider is contacted):

```ts
import { describe, test, expect } from "bun:test"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventsClient } from "@opencode-ai/events-client"
import { resolveSidecarBin } from "@opencode-ai/events-client/resolve"
import { runWorker } from "../../src/daemon/worker"
import { Effect, Layer } from "effect"
import { SessionExecution } from "@opencode-ai/core/session/execution"

describe("daemon worker", () => {
  test("registers a lease and adopts the root session, then releases on stop", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "daemon-worker-"))
    const journalDir = path.join(dir, "journal"); const db = path.join(dir, "proj.db"); const artifacts = path.join(dir, "artifacts")
    mkdirSync(journalDir); mkdirSync(artifacts)
    const sidecar = EventsClient.start({ sidecarBin: await resolveSidecarBin({}), journalDir, db, artifacts, session: "daemon" })
    const stub = Layer.effect(SessionExecution.Service, SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      resume: () => Effect.void,
      wake: () => Effect.void,
      interrupt: () => Effect.void,
      supervise: () => Effect.fail(new Error("stub: no supervise in worker test")),
    }))
    const stop = await runWorker({
      args: { workerId: "w-test", directory: dir, workspaceDirectory: dir, leaseFenceMs: 60_000, heartbeatMs: 10_000, tickPollMs: 10_000, idleGraceMs: 60_000 },
      transport: (method, params) => (sidecar as any).callForTest(method, params),
      sessionExecution: stub,
    })
    const leases = await sidecar.listLeases(dir)
    expect(leases.length).toBeGreaterThanOrEqual(1)
    await stop()
    expect(await sidecar.listLeases(dir)).toHaveLength(0)
    sidecar.dispose()
  })
})
```
(The worker must expose a way to stop — `runWorker` returns `stop(): Promise<void>` after the loops start; `callForTest` is a package-private raw RPC accessor on `EventsClient` mirroring the bridge's need — add it in Task 3 to `packages/ultracode-events-client/src/index.ts` as an internal `callRaw(method, params)` used by both the bridge and tests.) Run: `cd packages/opencode && bun test test/daemon/worker.test.ts`. Expected: FAIL — module missing.

- [ ] **Step 4: Implement `daemon/worker.ts` + `daemon/types.ts`** — as specified in `Produces`. The worker runtime composition: `ManagedRuntime.make(AppLayer, { memoMap })` is the default; when `deps.sessionExecution` is provided, rebuild the V2 merge `AppNodeBuilderV1.build(SessionV2.node, [[LocationServiceMap.node, buildLocationServiceMap()], [SessionExecution.node, deps.sessionExecution]])` merged over the rest of `AppLayer` (mirror the structure of `app-runtime.ts` lines 116–121; verify against Context File 10 while implementing). `runWorker` returns a `stop()` that releases leases and disposes the runtime. Add the `callRaw` accessor to `EventsClient` (package-private, same shape as `call`).

- [ ] **Step 5: Write the failing supervisor test** — `packages/opencode/test/daemon/supervisor.test.ts`: build `DaemonSupervisor.node` against tmp dirs + `resolveSidecarBin`, `runPromise` the layer scoped, assert `status().workerAlive === true` and a lease exists for a pre-created session after the worker's first heartbeat, then kill the worker child (`status().pid`, SIGKILL), assert the supervisor respawns (`waitFor workerAlive && pid !== oldPid`) and the new worker re-adopts the root (`listLeases` has a fresh `heartbeat_at`). Run: FAIL first, then implement `daemon/supervisor.ts` (spawn via `Bun.spawn`, `spawnBridge`, backoff respawn `[250, 1000, 5000]`, scoped finalizer `stop()`), then PASS.

- [ ] **Step 6: Wire daemon mode into the server** — in `packages/opencode/src/server/routes/instance/httpapi/server.ts` (the wiring point from Task 1), accept a `daemon` option; when true use `SessionExecution.noopLayer` (imported from `@opencode-ai/core/session/execution`) in place of `SessionExecutionLocal.node` at the V2 merge, and add `DaemonSupervisor.node` to the layer group. Thread `daemon?: boolean` through `Server.listen(opts)` → `listenEffect` → `listenerLayer` → `HttpApiApp.createRoutes(opts)` in `packages/opencode/src/server/server.ts`. Write `packages/opencode/test/daemon/one-executor.test.ts`: build the daemon server (via `Server.listen({ hostname: "127.0.0.1", port: 0, daemon: true })` or the httpapi builder used in Task 1 pins), create a V2 session via `client.session.create`, prompt it, then assert `client.session.active` returns `{}` (empty) while the session's durable event stream advances (the worker drained it) and `listLeases` contains the session. Run: `cd packages/opencode && bun test test/daemon/one-executor.test.ts`, then `cd packages/opencode && bun typecheck`.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/daemon packages/opencode/test/daemon packages/opencode/src/server/server.ts packages/opencode/src/server/routes/instance/httpapi/server.ts packages/ultracode-events-client/src/index.ts
git commit -m "feat(opencode): daemon worker process model with sidecar leases and adoption"
```

---

### Task 4: Attach/detach — durable resume via `sessions.events` + chunked catch-up

**Files:**
- Create: `packages/opencode/src/daemon/attach.ts` (`resumeSessionStream`)
- Create: `packages/opencode/test/daemon/attach.test.ts`
- Modify: `packages/opencode/src/cli/cmd/attach.ts` (daemon-aware detach semantics + session-scoped attach already present; extend `--session` to also work for daemon-owned sessions with `--replay-limit` documented; no behavioral break)

**Interfaces:**
- Consumes: `client.session.events({sessionID, after})` SSE stream and `client.session.history({sessionID, after, limit})` (Task 1 pin), `SessionEvent.Durable` (`@opencode-ai/schema/session-event`).
- Produces:
  - `daemon/attach.ts`: `resumeSessionStream(input: { client: OpencodeClient; sessionID: string; after?: number; chunkBytes?: number }): AsyncIterable<SessionEvent.Durable>` — catch-up path: page `session.history` from `after` (pages accumulate until `chunkBytes` target, default 512 * 1024 bytes, or `hasMore === false`), then switch to `session.events({sessionID, after: lastSeenSeq})` which replays the remainder then continues live; the returned iterable yields each durable event exactly once, in sequence order, with no gaps; `lastSeenSeq` is tracked so a dropped transport can be resumed by calling again with `after`.
  - CLI attach: `opencode attach <url> --session <id>` opens `resumeSessionStream`; detach (Ctrl-C / closing the stream / transport loss) never stops the worker; on reconnect the client resumes with `after = lastSeenSeq`.

- [ ] **Step 1: Write the failing test** — `packages/opencode/test/daemon/attach.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { createEmbeddedRoutes } from "@opencode-ai/server/routes"
import { createClient } from "@opencode-ai/client"   // verify the generated-client factory name in packages/client
import { resumeSessionStream } from "../../src/daemon/attach"

describe("resumeSessionStream", () => {
  test("attach mid-run replays after then continues live with no gaps", async () => {
    const app = createEmbeddedRoutes()   // WebHandler from @opencode-ai/server/routes
    const client = createClient({ fetch: app.fetch }) as OpencodeClient
    const created = (await client.session.create({ data: { location: { directory: process.cwd() } } })).data
    const id = created.id
    // admit two prompts (admission only: resume:false)
    await client.session.prompt({ params: { sessionID: id }, data: { prompt: "first", resume: false } })
    await client.session.prompt({ params: { sessionID: id }, data: { prompt: "second", resume: false } })

    // attach AFTER the events exist: must replay from after=0
    const seen: string[] = []
    for await (const event of resumeSessionStream({ client, sessionID: id, after: 0 })) {
      seen.push(event.durable?.seq ? String(event.durable.seq) : event.type)
      if (seen.length >= 2) break
    }
    expect(seen.length).toBe(2)
  })
})
```
Adjust the client factory and embedded-route construction to the real APIs pinned in Task 1 (Steps 5). The test asserts replay-from-`after` delivers the two admitted-prompt durable events in order. Run: `cd packages/opencode && bun test test/daemon/attach.test.ts`. Expected: FAIL — module missing.

- [ ] **Step 2: Implement `daemon/attach.ts`** — `resumeSessionStream`: read `session.history` pages (`limit: 50`) until accumulated bytes ≥ `chunkBytes` or `hasMore === false`, tracking the max durable seq; then open `session.events({sessionID, after: lastSeq})` and yield its replay-then-live events; dedupe by `id` (skip an event whose id was already yielded) so a seq boundary never double-yields; end the history loop at the first page that does not advance the max seq. Keep it a generator; attach tests drive it with `for await`.

- [ ] **Step 3: Verify detach semantics at the CLI surface** — extend `packages/opencode/test/daemon/session-events-pin.test.ts` or add `test/daemon/detach.test.ts`: spawn the daemon server from Task 3 Step 6, open `resumeSessionStream`, read 1 event, close the iterable (detach), admit another prompt, re-open `resumeSessionStream({ after: lastSeenSeq })`, assert the new event arrives and no event repeats. Run: PASS. Then document in `attach.ts` (command description) that `--session` on a daemon server attaches to a running worker-owned session and that detaching leaves execution running.

- [ ] **Step 4: Typecheck + commit**

```bash
cd packages/opencode && bun typecheck
git add packages/opencode/src/daemon/attach.ts packages/opencode/test/daemon/attach.test.ts packages/opencode/test/daemon/detach.test.ts packages/opencode/src/cli/cmd/attach.ts
git commit -m "feat(opencode): durable attach/detach via resumable session event streams"
```

---

### Task 5: `/goal` — durable DAG root with drain-end continuations until `goal.complete`

**Files:**
- Create: `packages/opencode/src/daemon/goal-engine.ts` (`GoalEngine` service)
- Create: `packages/opencode/src/tool/goal.ts` (`goal` tool)
- Create: `packages/opencode/test/daemon/goal-engine.test.ts`
- Create: `packages/opencode/test/tool/goal-tool.test.ts`
- Modify: `packages/opencode/src/daemon/worker.ts` (hook the goal engine into the post-drain path)
- Modify: `packages/ultracode-events-client/src/index.ts` (goal client methods from Task 2: `createGoal`, `listGoals`, `getGoal`, `recordGoalUsage`, `completeGoal`)

**Interfaces:**
- Consumes: sidecar goal RPCs (Task 2), `SessionExecution.supervise`/`TerminalRunResult` (Task 1), `SessionV2.prompt({id, sessionID, prompt, delivery})` idempotent admission (Context File 3), `SessionEvent` durable events.
- Produces:
  - `daemon/goal-engine.ts`: `GoalEngine.Service` (`@opencode/daemon/GoalEngine`) with `continuationAfterRun(input: { sessionID: SessionSchema.ID; run: SessionExecution.TerminalRunResult }): Effect<"continue" | "stop" | "budget_limited">` — reads the active goal for the session (`getGoal` + `listGoals({workspaceDirectory, status: "active"})`); if none → `"stop"`; if `status === "complete"` → `"stop"`; if token/turn/time budget exhausted → `recordGoalUsage(...)` then `"budget_limited"`; else admits a continuation prompt with deterministic id `goal:<goalId>:<seq>` (`delivery: "steer"`) whose text is a `<goal_context>`-style continuation (objective + status + budget + "audit every requirement before completing; do not call goal.complete unless the goal is genuinely complete"), then `recordGoalUsage` journals the run's `usage`, then returns `"continue"`. Also `start(input: { sessionID; objective; tokenBudget? }): Effect<GoalRecord>` and `complete(input: { goalID; summary }): Effect<void>` delegating to sidecar `createGoal`/`completeGoal` (keys `goal-create:<id>`, `goal-complete:<id>`).
  - `daemon/goal-tool.ts` (in `packages/opencode/src/tool/goal.ts`): a V2 tool with `name: "goal"`, params `{ action: "complete" | "status"; summary?: string }`; on `complete` it calls `GoalEngine.complete` for the session's active goal and returns `{ goal_id, status: "complete" }`; on `status` it returns the active goal snapshot. Registered through the same V2 tool-registration path the `task` tool uses (verify in Task 1/3 while reading `packages/opencode/src/tool/task.ts` + how the worker's runner materializes tools; register it in the worker runtime).
  - Sidecar goal client methods on `EventsClient`: `createGoal(input)`, `listGoals(input)`, `getGoal(input)`, `recordGoalUsage(input)`, `completeGoal(input)` wrapping the Task 2 RPCs.
- Goal status vocabulary (sidecar `goals.status`): `active | paused | budget_limited | complete`.

- [ ] **Step 1: Write the failing goal-engine test** — `packages/opencode/test/daemon/goal-engine.test.ts` (real sidecar binary + tmp dirs, scripted `SessionExecution`):

```ts
import { describe, test, expect } from "bun:test"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventsClient } from "@opencode-ai/events-client"
import { resolveSidecarBin } from "@opencode-ai/events-client/resolve"
import { createGoalEngine } from "../../src/daemon/goal-engine"
import { Effect, Layer } from "effect"
import { SessionExecution } from "@opencode-ai/core/session/execution"

describe("goal engine", () => {
  test("goal-until-complete: continues after a run until the goal is completed, then stops", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "goal-engine-"))
    const journalDir = path.join(dir, "journal"); const db = path.join(dir, "proj.db"); const artifacts = path.join(dir, "artifacts")
    mkdirSync(journalDir); mkdirSync(artifacts)
    const sidecar = EventsClient.start({ sidecarBin: await resolveSidecarBin({}), journalDir, db, artifacts, session: "daemon" })
    const admitted: string[] = []
    const engine = createGoalEngine({
      sidecar,
      workspaceDirectory: dir,
      admit: (id) => Effect.sync(() => admitted.push(id)),
    })
    const goal = await engine.start({ sessionID: "ses_root" as never, objective: "ship the release", tokenBudget: 10_000 })

    const run = { status: "completed", usage: { tokens: 10, turns: 1, elapsedMs: 100 }, artifactIds: [], changedPaths: [] } as const
    expect(await engine.continuationAfterRun({ sessionID: "ses_root" as never, run })).toBe("continue")
    expect(admitted.length).toBe(1)
    expect(admitted[0]).toContain(`goal:${goal.goalId}:`)

    // simulate the model completing the goal via the tool
    await engine.complete({ goalID: goal.goalId, summary: "verified artifacts" })
    expect(await engine.continuationAfterRun({ sessionID: "ses_root" as never, run })).toBe("stop")
    expect(admitted.length).toBe(1)
    sidecar.dispose()
  })

  test("budget exhaustion marks budget_limited and stops without completing", async () => {
    // createGoal with tokenBudget 25; run reports 30 tokens; continuationAfterRun returns "budget_limited"
    // and getGoal(...).status === "budget_limited"; the goal is NOT complete.
  })
})
```
Run: FAIL (module missing), then implement `daemon/goal-engine.ts` (`createGoalEngine(deps)` returning the engine object; worker wraps it in a `GoalEngine.Service`). Then PASS.

- [ ] **Step 2: Wire the engine into the worker post-drain path** — in `daemon/worker.ts`, after a supervised run for an owned session returns a `TerminalRunResult`, call `goalEngine.continuationAfterRun({ sessionID, run })`; on `"continue"` call `SessionExecution.wake(sessionID)`; on `"budget_limited"` admit the budget-limit `<goal_context>` continuation once (deterministic id `goal:<goalId>:budget`) and do not wake again. Keep the drain loop bounded: a `"continue"` that immediately re-drains is allowed; consecutive `"continue"` results are counted and capped by the goal's token/turn budget (a continuation that consumes budget counts via `recordGoalUsage`).

- [ ] **Step 3: Write the failing goal-tool test** — `packages/opencode/test/tool/goal-tool.test.ts`: decode the tool params schema (`{ action: "complete", summary }`, `{ action: "status" }`), and with a stubbed `GoalEngine` assert `complete` calls `engine.complete` with the active goal id and returns `{ goal_id, status: "complete" }`; `status` returns the snapshot. Implement `packages/opencode/src/tool/goal.ts` following the `task` tool's structure. Run: PASS.

- [ ] **Step 4: Typecheck + commit**

```bash
cd packages/opencode && bun typecheck
git add packages/opencode/src/daemon/goal-engine.ts packages/opencode/src/tool/goal.ts packages/opencode/test/daemon/goal-engine.test.ts packages/opencode/test/tool/goal-tool.test.ts packages/ultracode-events-client/src/index.ts
git commit -m "feat(opencode): durable /goal with drain-end continuations and budget accounting"
```

---

### Task 6: Heartbeats and schedules — claimed-and-advanced ticks, coalescing, exactly-once delivery

**Files:**
- Create: `packages/opencode/src/daemon/worker-scheduler.ts` (`runScheduler`, `deliverTick`)
- Create: `packages/opencode/test/daemon/scheduler.test.ts`
- Modify: `packages/opencode/src/daemon/worker.ts` (start `runScheduler`)
- Modify: `packages/ultracode-events-client/src/index.ts` (schedule client methods: `createSchedule`, `listSchedules`, `cancelSchedule`, `claimTick`, `completeJob`, `failJob`)

**Interfaces:**
- Consumes: sidecar `create_schedule`/`claim_tick`/`complete_job`/`fail_job` (Task 2), `SessionV2.prompt({id,...})` idempotent admission, `SessionEvent` durable events.
- Produces:
  - `daemon/worker-scheduler.ts`: `runScheduler(deps: { sidecar: EventsClient; workspaceDirectory: string; tickPollMs: number; admit: (input: { id: string; sessionID: string; prompt: string; delivery: "steer" }) => Effect<void> }): Effect<void>` — loop: every `tickPollMs` call `claimTick({ workerId, workspaceDirectory })`; for each claimed job call `deliverTick(deps, job)` then `completeJob({ key: `job:complete:${job.jobId}`, jobId, workspaceDirectory })`; on admission failure call `failJob({ key: `job:fail:${job.jobId}`, jobId, workspaceDirectory, reason })`. `deliverTick` admits the tick prompt with `id = SessionMessage.ID.make(job.data.input_id)` (`tick:<schedule_id>:<seq>`), `delivery: "steer"`, and `resume: false`; admission is idempotent so a redelivered tick (crash after admission, before complete) yields the existing admitted record and no duplicate visible prompt. `runScheduler` returns a stop handle; the loop is interrupted on worker shutdown.
  - Worker wiring: `runScheduler` runs in the worker alongside heartbeat; schedules are per-workspace (the daemon's `workspaceDirectory`). Creating a schedule for a session is how a session becomes daemon-owned (Task 8 exposes `schedule.create`).

- [ ] **Step 1: Write the failing tests** — `packages/opencode/test/daemon/scheduler.test.ts` (real sidecar + tmp dirs + scripted admit recorder):

```ts
import { describe, test, expect } from "bun:test"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventsClient } from "@opencode-ai/events-client"
import { resolveSidecarBin } from "@opencode-ai/events-client/resolve"
import { deliverTick, runScheduler } from "../../src/daemon/worker-scheduler"

describe("daemon scheduler", () => {
  test("delivers a claimed tick once with a deterministic id", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sched-"))
    const journalDir = path.join(dir, "journal"); const db = path.join(dir, "proj.db"); const artifacts = path.join(dir, "artifacts")
    mkdirSync(journalDir); mkdirSync(artifacts)
    const sidecar = EventsClient.start({ sidecarBin: await resolveSidecarBin({}), journalDir, db, artifacts, session: "daemon" })
    await sidecar.createSchedule({ key: "sched:create:s1", scheduleId: "s1", sessionId: "ses_root", workspaceDirectory: dir, cronExpr: "* * * * *", prompt: "check the deployment", delivery: "steer" })
    const job = (await sidecar.claimTick({ workerId: "w", workspaceDirectory: dir }))!
    const admitted: string[] = []
    const admit = async (input: { id: string }) => { admitted.push(input.id) }
    await deliverTick({ sidecar, workspaceDirectory: dir, admit } as never, job)
    expect(admitted).toEqual([job.data.input_id])
    await sidecar.completeJob({ key: `job:complete:${job.jobId}`, jobId: job.jobId, workspaceDirectory: dir })
    sidecar.dispose()
  })

  test("crash mid-tick redelivers exactly once (no duplicate prompt)", async () => {
    // claimTick → deliverTick (admit recorder "crashes" by throwing) → simulate crash by NOT completing.
    // The job stays 'running'; the sidecar rebuild resets it to 'pending'. Re-claim returns the SAME job_id.
    // A real admit recorder keyed by id proves the same input_id is admitted, and the admission layer's
    // idempotency (SessionInput.admit) would return the existing record — assert the recorder sees one id.
    const job = (await sidecar.claimTick({ workerId: "w", workspaceDirectory: dir }))!
    const ids: string[] = []
    let crash = true
    const admit = async (input: { id: string }) => { if (crash) throw new Error("boom"); ids.push(input.id) }
    await expect(deliverTick({ sidecar, workspaceDirectory: dir, admit } as never, job)).rejects.toThrow("boom")
    await sidecar.rebuildProjections("daemon")
    const again = (await sidecar.claimTick({ workerId: "w", workspaceDirectory: dir }))!
    expect(again.jobId).toBe(job.jobId)
    crash = false
    await deliverTick({ sidecar, workspaceDirectory: dir, admit } as never, again)
    expect(ids).toEqual([job.data.input_id])
    sidecar.dispose()
  })
})
```
Run: FAIL (methods missing), then add the schedule client methods to `packages/ultracode-events-client/src/index.ts` (`createSchedule`, `listSchedules`, `cancelSchedule`, `claimTick`, `completeJob`, `failJob` wrapping the Task 2 RPCs), then PASS. Implement `runScheduler` + `deliverTick` in `daemon/worker-scheduler.ts`.

- [ ] **Step 2: Wire `runScheduler` into the worker** — start the scheduler loop in `runWorker`; the scheduler's `admit` uses `SessionV2.prompt({ id: SessionMessage.ID.make(input.id), sessionID, prompt: input.prompt, delivery: input.delivery, resume: false })`. Ensure the heartbeat loop and scheduler loop are both forked in the worker's scope and interrupted on stop.

- [ ] **Step 3: Coalescing at the worker level** — add a test asserting that after a period where the sidecar was unreachable (or the scheduler was paused), `claimTick` returns exactly one tick whose `seq` is `previous + 1` and `listSchedules(...).next_due_ms` is in the future (Task 2's Rust test already pins the sidecar side; the TS test pins the worker-facing shape). Run: PASS.

- [ ] **Step 4: Typecheck + commit**

```bash
cd packages/opencode && bun typecheck
git add packages/opencode/src/daemon/worker-scheduler.ts packages/opencode/test/daemon/scheduler.test.ts packages/opencode/src/daemon/worker.ts packages/ultracode-events-client/src/index.ts
git commit -m "feat(opencode): sidecar-claimed schedule ticks with exactly-once delivery"
```

---

### Task 7: Bounded autonomy — limits, quality gates, workspace-hash skip, verdict journaling

**Files:**
- Create: `packages/opencode/src/daemon/autonomy.ts` (`createAutonomousRunner`, `runGate`, `captureWorkspaceHash`)
- Create: `packages/opencode/test/daemon/autonomy.test.ts`
- Modify: `packages/opencode/src/daemon/worker.ts` (optional `autonomous` config: wrap supervised runs)
- Modify: `packages/ultracode-events-client/src/index.ts` (`listGateVerdicts`)

**Interfaces:**
- Consumes: `SessionExecution.supervise`/`TerminalRunResult` (Task 1), sidecar `AutonomyGateVerdict` event + `list_gate_verdicts` (Task 2), `SessionV2.prompt` idempotent admission.
- Produces:
  - `daemon/autonomy.ts`:
    - `AutonomousConfig { enabled?: boolean; maxContinuations?: number; maxTurns?: number; maxTokens?: number; timeoutMs?: number; gates?: { commands: string[]; maxRetries?: number; timeoutMs?: number } }` with defaults `{ maxContinuations: 3, maxTurns: 12, maxTokens: 80_000, timeoutMs: 30 * 60_000, gates: { commands: [], maxRetries: 3, timeoutMs: 5 * 60_000 } }`.
    - `createAutonomousRunner(deps: { sidecar: EventsClient; workspaceDirectory: string; admit: (input: { id: string; sessionID: string; prompt: string; delivery: "steer" }) => Effect<void> })` returning `{ shouldContinue(input: { sessionID; run: TerminalRunResult; state }): Effect<{ shouldContinue: boolean; reason: "gate_passed" | "gate_failed" | "limit_reached" | "continue" }>` }`. On each run: first run quality gates (`runGate` per command); gate passed → stop (reason `gate_passed`); gate failed → feed the bounded failure output back as a steer continuation (`reason: "gate_failed"`) unless the same command failed on an identical workspace hash and attempts ≥ maxRetries (→ `limit_reached`, do NOT rerun); no gates configured → continue until a limit is reached (`maxContinuations | maxTurns | maxTokens | timeoutMs`, excluding cache-read tokens per the audit's "excluding cache-read" note — count `usage.input + usage.output + usage.cache.write`).
    - `runGate(command: string, cwd: string, timeoutMs: number): Effect<{ passed: boolean; output: string; truncated: boolean; timedOut: boolean; exitText: string }>` — runs the command via `Bun.spawn` with a shell, caps combined stdout+stderr at 6000 chars (`MAX_GATE_OUTPUT_CHARS`), kills on timeout.
    - `captureWorkspaceHash(cwd: string): Effect<string>` — sha256 over `git status --porcelain -z` + `git diff --no-ext-diff` + sha256 of each untracked file's bytes (reimplemented from the invariant "skip a failed gate when the workspace has not changed"; keep it simple, exclude nothing, tolerate non-git dirs by returning a fixed sentinel).
    - Verdict journaling: after each gate run, `sidecar.proposeCommit(`gate-verdict:<session>:<command>:<attempt>`, { kind: "autonomy-gate-verdict", data: { session_id, command, attempt, passed, rerun_skipped, workspace_hash, exit_text, output, at_ms } })`; `listGateVerdicts` reads them back.
  - "Limit is not success": the autonomous wrapper reports the run's terminal status unchanged; a limit-stopped run keeps its `budget_exhausted`/`timed_out` status and never marks a goal complete.

- [ ] **Step 1: Write the failing tests** — `packages/opencode/test/daemon/autonomy.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventsClient } from "@opencode-ai/events-client"
import { resolveSidecarBin } from "@opencode-ai/events-client/resolve"
import { createAutonomousRunner, captureWorkspaceHash } from "../../src/daemon/autonomy"

describe("autonomous runner", () => {
  test("a passed gate checks only what it verifies: gate pass stops the run as success", async () => {
    const runner = createAutonomousRunner({ sidecar: null as never, workspaceDirectory: "", admit: async () => {} } as never)
    const state = { continuationsUsed: 0, turnsUsed: 1, tokensUsed: 0, startedAt: Date.now(), gateAttempts: {}, lastGateFailure: undefined }
    const decision = await runner.shouldContinue({
      sessionID: "ses_root" as never,
      state,
      gates: { commands: ["true"], maxRetries: 3, timeoutMs: 5000 },
      limits: { maxContinuations: 3, maxTurns: 12, maxTokens: 80_000, timeoutMs: 30 * 60_000 },
      cwd: process.cwd(),
    })
    expect(decision.reason).toBe("gate_passed")
  })

  test("limit is not success: token budget exhaustion stops with limit_reached", async () => {
    const runner = createAutonomousRunner({ sidecar: null as never, workspaceDirectory: "", admit: async () => {} } as never)
    const decision = await runner.shouldContinue({
      sessionID: "ses_root" as never,
      state: { continuationsUsed: 3, turnsUsed: 12, tokensUsed: 80_000, startedAt: Date.now(), gateAttempts: {}, lastGateFailure: undefined },
      gates: { commands: [], maxRetries: 3, timeoutMs: 5000 },
      limits: { maxContinuations: 3, maxTurns: 12, maxTokens: 80_000, timeoutMs: 30 * 60_000 },
      cwd: process.cwd(),
    })
    expect(decision.reason).toBe("limit_reached")
    expect(decision.shouldContinue).toBe(false)
  })

  test("workspace-hash skip: unchanged workspace does not rerun the failed gate", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gate-skip-")); mkdirSync(dir)
    // git init + a file; run a failing gate twice with no workspace change between;
    // assert the second run does NOT rerun (gateAttempts increments, no new process),
    // and output text says "workspace unchanged".
  })
})
```
Run: FAIL (module missing), then implement `daemon/autonomy.ts`. Adjust the `shouldContinue` signature to the exact shape you implement; the tests assert the three invariants above. Then PASS. Add the `listGateVerdicts` client method.

- [ ] **Step 2: Wire autonomy into the worker** — when the worker's config has autonomous mode for a session (config flag `autonomous.enabled` or per-goal), wrap the post-run path: run gates after each drain, feed failures back as steer continuations, stop on `gate_passed`/`limit_reached`. Journal verdicts through the sidecar. Keep the wrapper a thin policy over `SessionExecution.supervise` (supervise's limits remain authoritative).

- [ ] **Step 3: Verdict journaling round-trip test** — with the real sidecar, after a failed gate run, `listGateVerdicts({ sessionId, limit: 10 })` returns the verdict with bounded `output` (≤6000 chars, `truncated: true` if capped) and `workspace_hash`. Run: PASS.

- [ ] **Step 4: Typecheck + commit**

```bash
cd packages/opencode && bun typecheck
git add packages/opencode/src/daemon/autonomy.ts packages/opencode/test/daemon/autonomy.test.ts packages/opencode/src/daemon/worker.ts packages/ultracode-events-client/src/index.ts
git commit -m "feat(opencode): bounded autonomous mode with quality gates and verdict journaling"
```

---

### Task 8: CLI/TUI surfaces — `serve --daemon`, `status`, `goal`, attach; protocol group + regenerated client

**Files:**
- Create: `packages/protocol/src/groups/daemon.ts` (`server.daemon` group)
- Create: `packages/server/src/handlers/daemon.ts`
- Modify: `packages/protocol/src/api.ts` (mount the daemon group)
- Modify: `packages/opencode/src/cli/cmd/serve.ts` (add `--daemon`)
- Create: `packages/opencode/src/cli/cmd/status.ts` (`opencode status [url]`)
- Create: `packages/opencode/src/cli/cmd/goal.ts` (`opencode goal <create|list|status|pause|resume|clear>`)
- Create: `packages/opencode/test/daemon/cli.test.ts`
- Modify: `packages/opencode/src/cli/cmd/attach.ts` (document `--session` daemon attach; no breaking change)
- Modify: `packages/opencode/src/cli/cmd/cmd.ts` (register new commands)
- Run: `cd packages/client && bun run generate`

**Interfaces:**
- Consumes: `DaemonSupervisor.Service.status` (Task 3), sidecar goal/schedule client methods (Tasks 2/5/6), CLI command pattern from `serve.ts`/`attach.ts` (`effectCmd`/`cmd`), protocol group pattern from `packages/protocol/src/groups/session.ts`, handler pattern from `packages/server/src/handlers/session.ts`.
- Produces:
  - `server.daemon` group (`/api/daemon/*`): `daemon.status` GET → `DaemonStatus { workerId, workerAlive, pid, leases: WorkerLeaseRow[], schedules: ScheduleRow[], goals: GoalRow[] }`; `daemon.goal.create` POST `{ sessionID, objective, tokenBudget? }`; `daemon.goal.list` GET `{ workspace?, status? }`; `daemon.goal.pause` POST `{ goalID }`; `daemon.goal.resume` POST `{ goalID }`; `daemon.goal.clear` POST `{ goalID }`; `daemon.schedule.create` POST `{ sessionID, cron, prompt, delivery }`; `daemon.schedule.list` GET `{ workspace? }`; `daemon.schedule.cancel` POST `{ scheduleID }`.
  - Handlers in `packages/server/src/handlers/daemon.ts` yield `DaemonSupervisor.Service` (from `@opencode-ai/opencode`? — the server package must depend on the supervisor; if that coupling is impossible, the supervisor's `status` and the goal/schedule RPC clients are provided through the daemon service in the opencode package and the handler delegates to it; verify the dependency direction during implementation and record any deviation).
  - CLI `opencode serve --daemon`; `opencode status [url]` prints the `daemon.status` payload (worker, leases, schedules, goals) for a local or remote server; `opencode goal <create|list|pause|resume|clear>` calls the daemon group; `opencode attach <url> --session <id>` attaches to a daemon-owned session (detach leaves the worker running — no code change beyond docs, verified by the CLI test).

- [ ] **Step 1: Write the failing CLI test** — `packages/opencode/test/daemon/cli.test.ts`:

```ts
import { describe, test, expect, afterAll } from "bun:test"
import { spawn } from "bun"

const CLI = new URL("../../bin/opencode", import.meta.url).pathname

describe("daemon CLI surfaces", () => {
  test("serve --daemon runs, status reports a worker, goal create registers a durable goal", async () => {
    const server = spawn({ cmd: [process.execPath, CLI, "serve", "--daemon", "--port", "0"], stdout: "pipe", stderr: "pipe" })
    // parse the "listening on http://127.0.0.1:<port>" line from stdout
    const url = await waitForUrl(server)
    const status = spawn({ cmd: [process.execPath, CLI, "status", url], stdout: "pipe" })
    const out = (await collect(status)).stdout
    expect(out).toContain("workerId")
    server.kill()
  })
})
```
(Follow the existing CLI-test spawn/collect helpers in `packages/opencode/test/cli` if present.) Run: FAIL — `--daemon` unknown. Then implement: `serve.ts` adds the `--daemon` flag and threads it into `Server.listen({ ..., daemon })`; `cmd/status.ts` and `cmd/goal.ts`; register in `cmd/cmd.ts`. Then PASS.

- [ ] **Step 2: Add the protocol group + handlers + regenerate client** — create `packages/protocol/src/groups/daemon.ts` (mirror `groups/session.ts` group style), mount in `packages/protocol/src/api.ts`, implement `packages/server/src/handlers/daemon.ts`, then run `cd packages/client && bun run generate`. Assert the generated client exposes `client.daemon.status()`, `client.daemon.goal.create(...)`, `client.daemon.schedule.create(...)` (check the generated method names and use them in the CLI commands). `bun typecheck` in `packages/protocol`, `packages/server`, `packages/client`, `packages/opencode`.

- [ ] **Step 3: End-to-end drive via HTTP** — extend `cli.test.ts`: create a session via the HTTP client, `daemon.goal.create`, assert the worker's sidecar `getGoal` shows `active`, then `daemon.goal.clear` and assert the sidecar no longer lists it as active. Run: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/src/groups/daemon.ts packages/protocol/src/api.ts packages/server/src/handlers/daemon.ts packages/opencode/src/cli/cmd/serve.ts packages/opencode/src/cli/cmd/status.ts packages/opencode/src/cli/cmd/goal.ts packages/opencode/src/cli/cmd/attach.ts packages/opencode/src/cli/cmd/cmd.ts packages/opencode/test/daemon/cli.test.ts packages/client/src/generated packages/client/src/generated-effect
git commit -m "feat(opencode): daemon CLI and protocol surfaces for status goals and schedules"
```

---

### Task 9: Conformance — long-running scenario + crash matrix

**Files:**
- Create: `packages/opencode/test/daemon/conformance.test.ts`
- Create: `packages/opencode/test/daemon/CRASH-MATRIX.md`
- Modify: `packages/opencode/test/daemon/worker.test.ts` or conformance file (test helper for crash injection)

**Interfaces:**
- Consumes: everything from Tasks 2–8.
- Produces: the crash matrix as a checked-in md with one checklist row per failure point; a conformance suite asserting the invariants.

- [ ] **Step 1: Write the failing full-scenario test** — `conformance.test.ts`:

```ts
describe("daemon conformance", () => {
  test("detach -> heartbeat -> attach -> goal complete: one uninterrupted run", async () => {
    // 1. start daemon server + worker (helpers from Task 8/3)
    // 2. create a session, attach via resumeSessionStream
    // 3. create a goal via the HTTP daemon.goal.create; admit a prompt
    // 4. detach (close the stream); assert the worker keeps draining (listLeases heartbeat advances, goal usage recorded)
    // 5. schedule a heartbeat tick; detach; assert the tick is delivered once (admit recorder, no duplicate id)
    // 6. re-attach with after=lastSeenSeq; assert replay continues with no gaps and no repeats
    // 7. complete the goal via the goal tool; assert no further continuations are admitted
    // 8. assert no duplicated visible prompts across the whole scenario (collect all admitted ids, assert unique)
  })

  test("crash mid-drain: no duplicated prompt, session resumes", async () => {
    // worker drained via scripted SessionExecution that records its own invoke count;
    // SIGKILL the worker mid-drain; supervisor respawns; assert the session's durable
    // events contain the admitted prompt exactly once and the new worker re-adopts.
  })

  test("crash between tick delivery and complete_job: tick delivered exactly once", async () => {
    // (the scheduler.test.ts redelivery test covers the sidecar contract; here assert at the
    // process level that after a worker crash the tick's input_id appears once in the session.)
  })
})
```
Run: FAIL (helpers may not all exist), then implement whatever small test helpers are missing (the supervisor/worker helpers from Tasks 3/8 are the real implementation — reuse, do not duplicate logic into the test).

- [ ] **Step 2: Write CRASH-MATRIX.md** — checked in at `packages/opencode/test/daemon/CRASH-MATRIX.md` with one row per failure point, each pinned to a test name in the suite:

```
| # | Failure point                       | Injection                       | Assertion (test name)                          | Status |
|---|-------------------------------------|---------------------------------|------------------------------------------------|--------|
| 1 | during prompt admission             | scripted admit throws once      | no duplicate visible prompt; resume            | ☐      |
| 2 | mid provider turn (drain)           | scripted drain interrupted      | no duplicate prompt; re-adopt                  | ☐      |
| 3 | between claim_tick and delivery     | kill after claim, before admit  | tick delivered exactly once (input_id unique)  | ☐      |
| 4 | between delivery and complete_job   | kill after admit, before complete| job re-claimed same job_id; admit idempotent  | ☐      |
| 5 | during goal continuation injection  | kill after run, before admit    | goal not double-completed; no extra continuation| ☐      |
```
Each row's test must pass; fill `Status` with `☑` as the orchestrator verifies each command. The md's test names must match real `bun test` names (orchestrator verifies each with `bun test test/daemon/<file> -t <name>`).

- [ ] **Step 3: Run the suite and mark the matrix** — `cd packages/opencode && bun test test/daemon` — every conformance + worker + scheduler + goal test green; every CRASH-MATRIX row marked `☑` with its verifying command recorded in the run ledger.

- [ ] **Step 4: Typecheck + commit**

```bash
cd packages/opencode && bun typecheck
git add packages/opencode/test/daemon/conformance.test.ts packages/opencode/test/daemon/CRASH-MATRIX.md packages/opencode/test/daemon/worker.test.ts
git commit -m "test(opencode): daemon conformance suite and crash matrix"
```

---

### Task 10: Docs + run ledger

**Files:**
- Create: `docs/provenance/sources.json`
- Create: `docs/provenance/ledger.json`
- Create: `docs/architecture/2026-08-06-daemon-workers.md` (short: process model, invariants, crash matrix pointer, follow-ups)
- Modify: `TODO/README.md` (Cross-Run Interface Registry row + run ledger row)

**Interfaces:**
- Consumes: `scripts/provenance/validate.ts` schema, the audit's provenance rules (ULTRACODE.md §5), the run's Deviation Log.
- Produces: validated provenance entries; the run ledger row with commit range.

- [ ] **Step 1: Write the provenance entries** — create `docs/provenance/sources.json` (one source for `../prime-agent`, pinned commit `c22549a3`, `repo_path: "../../prime-agent"`, `license_spdx: "MIT"`, `license_file: "LICENSE"`) and `docs/provenance/ledger.json` (`version: 1`) with one import per design concept reimplemented in this run: `id: "run14-prime-goals"`, `source_id: "prime-agent"`, `treatment: "reimplement"`, `destination: "packages/opencode/src/daemon/goal-engine.ts"`, `owner: "opencode"`, `imported_from_commit: "c22549a3..."` (the actual 40-char commit from `git -C ../prime-agent rev-parse HEAD`), `license_spdx: "MIT"`, `notice_required: true`, `imported_at` (today), `local_modifications: ["goal_context wording reimplemented from the invariant, not copied text"]`, `upstream_merge_owner: "opencode"`; plus sibling entries for the worker process model, schedules/claim-and-advance, and autonomous gates (one per design area, each `destination` pointing at the file that implements it). Run `bun run scripts/provenance/validate.ts` — PASS.

- [ ] **Step 2: Write the architecture doc** — `docs/architecture/2026-08-06-daemon-workers.md`: one-page — process model (server noop / worker drains / supervisor watchdog), the one-executor and one-writer invariants, the exactly-once delivery mechanism (deterministic input ids + `SessionInput.admit`), the crash matrix pointer, and explicit follow-ups: (a) multi-worker horizontal scaling and cross-process shared Session execution ownership = clustering, deferred by AGENTS.md; (b) cross-process `session.interrupt` for daemon-owned sessions is a no-op in the server in daemon mode (worker-local interrupt only), deferred; (c) V1 sessions are outside daemon ownership; (d) per-workspace multi-directory daemon is future work.

- [ ] **Step 3: Update TODO/README.md** — add the RUN-14 row to the Cross-Run Interface Registry (`DaemonSupervisor.Service.status`, `resumeSessionStream`, sidecar `agent_jobs`/`schedules`/`worker_leases`/`goals`/`gate_verdicts` tables + RPCs, `server.daemon` group) and append the run ledger row with the commit range (`git log --oneline origin/main..HEAD` range), baselines green, and deviations from the Deviation Log.

- [ ] **Step 4: Final verification + commit** — orchestrator-runs: `cargo test -p ultracode-events`, `cargo clippy -p ultracode-events -- -D warnings`, `bun test test/daemon` in `packages/opencode`, `bun typecheck` in every touched package, `bun run scripts/provenance/validate.ts`, `git status` clean.

```bash
git add docs/provenance/sources.json docs/provenance/ledger.json docs/architecture/2026-08-06-daemon-workers.md TODO/README.md
git commit -m "docs: daemon workers provenance ledger, architecture note, and run ledger"
```

---

## Run-Level Review Prompt (dispatch after Task 10)

```
Review the commits <list hashes> in /home/thymia/UltraCode-Planning/opencode
implementing RUN-14 (file: opencode/TODO/RUN-14-daemon-workers.md).
Run-specific checks:
1. One executor per session: in daemon mode the server wires SessionExecution.noopLayer and
   the worker is the only drain. grep for SessionExecutionLocal wiring in the daemon path.
2. One writer to the sidecar: the worker uses EventsClient.fromTransport (IPC bridge); no second
   sidecar spawn in worker.ts; all mutations go through propose_commit idempotency keys or the
   sidecar's own claim/advance RPCs. grep worker.ts for EventsClient.start.
3. Exactly-once delivery: every injected prompt id is deterministic (tick:<schedule>:<seq>,
   goal:<goal_id>:<seq>) and admitted via SessionV2.prompt({ id, ... }); no duplicated visible
   prompt can arise from a crash-redelivery. Check CRASH-MATRIX.md rows 3–4 are ☑ and pinned to
   passing tests.
4. Limit is not success: no code path maps a limits/gate-retry stop to status "completed" or to
   goal.complete. Check the budget_exhausted test and the autonomy limit_reached test.
5. Additive Rust only: no existing RPC/table/envelope changed; cargo clippy -D warnings green.
6. Provenance: docs/provenance/ledger.json + sources.json exist, validate.ts passes, and no plan
   excerpt copies prime source text (goal/autonomy prompts are reimplemented).
7. Diff scope: only files declared in the run plan + generated client output.
Then the generic checks from TODO/README.md §5.1 items 1–5.
Reply numbered findings, BLOCKER or MINOR, file:line. No edits.
```

## Deviation Log (fill during execution)

| Task | Deviation | Reason |
|---|---|---|
