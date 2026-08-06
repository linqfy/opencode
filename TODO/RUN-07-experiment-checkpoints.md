# RUN-07: Agent Experiment Checkpoints + Unified Rewind

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the model a durable experiment lifecycle — branch from a checkpoint, compare candidate implementations, retain the winner with provenance — and give the user one unified rewind gesture that rewinds files + conversation + context epoch together.

**Architecture:** `ExperimentCheckpoint` is a journaled record (sidecar is the one journal authority per TODO/README §2.4 and audit §27.2) whose `snapshotHash` points into the existing shadow-git `Snapshot` service. Branching composes the existing V1 `Session.fork` (conversation lineage, EventV2-projected) with `Snapshot.restore` (worktree), optionally into an isolated worktree lease for parity with scheduler children. Compare reuses `Snapshot.diffFull`. Retain writes a second journal record with provenance. Unified rewind composes the existing V1 `SessionRevert.revert` (files + conversation boundary) with `SessionContextEpoch.reset` (fresh baseline). Codex has conversation-only backtrack and Claude has files+conversation without epoch discipline; this run composes all three.

**Tech Stack:** Bun, TypeScript, Effect-TS, Rust (cargo), Drizzle/SQLite (sidecar projections), newline-delimited JSON-RPC over stdio, git (shadow-git + worktrees).

**Audit basis:** §20.1 (unified rewind = files snapshot + conversation fork + context-epoch reset as one gesture; your three primitives, nobody else composes them), §16 (Claude rewind lacks epoch discipline), §15 (Codex backtrack = conversation fork only, no file checkpoints — shadow git is the differentiator), §22 "Rollback checkpoints for agent experiments" (branch-from-checkpoint, compare, retain with provenance — trivially expressible over shadow-git + worktree leases).

## Global Constraints

All constraints in `TODO/README.md` §2 apply verbatim. In addition:

- **One-owner rule (§2.4):** experiment provenance is *audit data* → the sidecar journal (`crates/ultracode-events`) is the single journal authority; TS code never writes journal files. Conversation lineage (the fork) is session data → EventV2 projection. Justification for the sidecar choice is in Task 2.
- **V1 freeze (§2.10):** `session/prompt.ts`, `processor.ts`, `session.ts` receive bugfixes only. RUN-07 *consumes* `Session.fork` and `SessionRevert.revert` (existing methods) and adds **new files** under `packages/opencode/src/snapshot/*` and `packages/opencode/src/tool/*`; it does not modify the frozen files.
- **No second snapshot system (§2.4):** every checkpoint's `snapshotHash` is produced by the existing `Snapshot.track()`; no new file-capture code.
- **Rust changes must pass** `cargo test -p ultracode-events` and `cargo clippy -p ultracode-events -- -D warnings` from repo root (Rust is exempt from the package-dir test rule). Envelope-shape changes require client-first; the RUN-07 additions are *additive* (new `EventKind` variants + one new RPC method) and must not alter existing semantics.
- **Tests real:** git repos in tmp dirs (`tmpdirScoped({ git: true })` / `provideTmpdirInstance(..., { git: true })`), real `Snapshot`/`Session` services, real sidecar binary for journal tests (`target/debug/sidecar` from `cargo build -p ultracode-events`). No mocks of the unit under test.
- **Branch:** `experiment-checkpoints` (§2.1).
- **API changes:** this run adds no public Protocol/Server HttpApi endpoint (the rewind surface is a service method; UI wiring is deferred to RUN-12). No `bun run generate` needed.

## Orchestrator Brief

### Context Files (read in full before dispatching each task; paths accurate 2026-08-06 — verify with `test -f`)

1. `packages/opencode/src/snapshot/index.ts` — `Snapshot.Interface`: `track()`, `patch(hash)`, `restore(snapshot)`, `revert(patches)`, `diff(hash)`, `diffFull(from, to) -> FileDiff[]` (FileDiff = `@opencode-ai/schema/file-diff` Info: `{file, patch, additions, deletions, status}`). 2MiB cap, gitignore reconciliation, per-project shadow gitdir under `Global.Path.data/snapshot/<project>/<hash>`.
2. `packages/opencode/src/session/revert.ts` — `SessionRevert.Service`: `revert({sessionID, messageID, partID?})`, `unrevert`, `cleanup`. Sets `session.revert = {messageID, partID?, snapshot, diff}`, restores files, publishes V1 `Session.Event.Diff`.
3. `packages/core/src/session/context-epoch.ts` — `initialize(db, context, sessionID)`, `prepare(...)`, `reset(db, sessionID)` (deletes the row so a fresh baseline renders on next init). `SessionContextEpochTable` lives in `packages/core/src/session/sql.ts`.
4. `packages/opencode/src/session/session.ts:669-734` — `Session.create` and the existing `Session.fork({sessionID, messageID?})` (clones messages strictly before `messageID`, new session id, parent lineage via `SessionV1.Event.Created` → V2 `SessionTable.parent_id`).
5. `packages/opencode/src/session/processor.ts:98-109, 424-469, 539-553` — per-turn snapshot hashes: `step-start`/`step-finish` parts carry `snapshot`, `patch` parts carry `{hash, files}` (the world state the checkpoint anchors to).
6. `packages/opencode/src/agent/scheduler.ts:86-183, 592-606` — `createWorktreeLeaseAdapter` (exported), `WorktreeLease`, `worktreeName(rootId, taskId) = "scheduler-<hex>-<hex>"`, `leaseKey`.
7. `packages/opencode/src/worktree/index.ts:119-121, 281-291` — `Worktree.Interface`: `makeWorktreeInfo({name})`, `createFromInfo(info)`, `create({name})`, `list()`, `remove({directory})`.
8. `packages/ultracode-events-client/src/index.ts` — `EventsClient.start(config)`, `fromTransport`, `proposeCommit(key, kind)`, `replay`, `IndexedEvent = {seq,id,kind,session,ts}` (no payload), `EventServiceConfig = {sidecarBin, journalDir, db, artifacts, session}`.
9. `crates/ultracode-events/src/event.rs` — `EventKind` serde adjacent-tagged enum (`{"kind":..., "data":{...}}`), SCHEMA_VERSION 1.
10. `crates/ultracode-events/src/projections.rs:214-260` (schema init block), `:392-397` `kind_name`, `:399-560` `index_record`, `:818-837` `list_events`, `:1278-1356` test harness (`write_journal` + `ProjectionStore::open`/`rebuild`).
11. `crates/ultracode-events/src/rpc.rs:156-199` — `dispatch`; `propose_commit` deserializes `kind` as `EventKind`; `list_events` maps rows to `{seq,id,kind,session,ts}`.
12. `packages/opencode/src/tool/tool.ts` — `Tool.define`, `Tool.Context` (`ctx.ask`, `ctx.messageID`, `ctx.sessionID`, `ctx.extra`), `Tool.init`.
13. `packages/opencode/src/tool/task.ts:121-199` — permission-gate pattern (`ctx.ask({permission: id, patterns, always, metadata})`).
14. `packages/opencode/src/tool/registry.ts:204-239` — builtin registration block (`Effect.all({...})` + `builtin: [...]` array).
15. `packages/opencode/test/session/revert-compact.test.ts` — the integration test harness RUN-07 reuses (message builders, `testEffect(LayerNode.compile(LayerNode.group([...])))`, `provideTmpdirInstance(..., {git: true})`).
16. `packages/opencode/test/snapshot/snapshot.test.ts` — snapshot test conventions (`it.instance`, `withTrackedSnapshot`, `fwd` helper).
17. `packages/opencode/src/project/instance-runtime.ts:9` — `InstanceRuntime.load({directory})` (real instance-context builder used for isolated-worktree restore).
18. `packages/opencode/src/effect/instance-ref.ts` — `InstanceRef = Context.Reference<InstanceContext | undefined>`; switch instance in production with `Effect.provideService(InstanceRef, ctx)`.

### Baselines (record before Task 1)

```bash
cd packages/opencode && bun test test/snapshot test/session/revert-compact.test.ts 2>&1 | tail -5
cd packages/opencode && bun typecheck 2>&1 | tail -3
cd packages/ultracode-events-client && bun test 2>&1 | tail -5
cargo test -p ultracode-events 2>&1 | tail -5
cargo build -p ultracode-events 2>&1 | tail -3
git -C /home/thymia/UltraCode-Planning/opencode checkout -b experiment-checkpoints
```

### Dispatch Order

Tasks 1 → 7 strictly sequential. Task 1 and Task 6 touch the same test harness (different files); still run in order. Task 2 must complete (sidecar RPC + client) before Task 3–5 TS tests (they list checkpoints); Task 3 before Task 4 (compare consumes branch-able records); Task 4 before Task 5 (retain references compare-able candidates).

### Definition of Done (verify each with a command you ran)

- [ ] `cargo test -p ultracode-events` green and `cargo clippy -p ultracode-events -- -D warnings` clean after Task 2.
- [ ] `bun test` green for: `packages/opencode/test/snapshot/run07-characterize.test.ts`, `.../experiment.test.ts`, `.../experiment-branch.test.ts`, `.../experiment-compare.test.ts`, `.../experiment-retain.test.ts`, `.../rewind.test.ts`, `packages/opencode/test/tool/experiment.test.ts`, `packages/ultracode-events-client/test/experiment.test.ts`.
- [ ] `bun typecheck` passes in `packages/opencode`, `packages/ultracode-events-client`.
- [ ] A journal round-trip works against the real sidecar: `experiment.test.ts` (client) proposes `experiment-checkpoint-created` + `experiment-retained` for the same `checkpoint_id` and `list_experiment_checkpoints` returns the created row with the retained block attached.
- [ ] The branch/compare/retain flow works in a real tmp git repo: `mark` → edit → `mark` → `branch` from first checkpoint (files return to first state, fork session has messages ≤ boundary) → `compare` reports the diff → `retain` with provenance shows in `list`.
- [ ] `Rewind.rewind` restores files, removes messages after the boundary, and deletes the `session_context_epoch` row (tested with an epoch row seeded via `SessionContextEpoch.initialize`).
- [ ] `git status` clean; branch `experiment-checkpoints`; every change committed (§2.2); run ledger (§8 of README) + cross-run registry (§7) row confirmed/present.
- [ ] No edits to `session/prompt.ts`, `processor.ts`, `session.ts` (diff check).

---

### Task 1: Characterize snapshot / revert / fork / epoch primitives

**Files:**
- Create: `packages/opencode/test/snapshot/run07-characterize.test.ts`

**Interfaces:**
- Consumes: `Snapshot.Service` (`track`/`restore`/`diffFull`), `Session.Service` (`create`/`updateMessage`/`updatePart`/`fork`), `SessionContextEpoch` (`initialize`/`reset`), `Database.Service`, `SystemContext.empty`, `SessionContextEpochTable` (read-only).
- Produces: pinned behavioral contracts — (a) `track()` returns a stable tree hash and `restore(hash)` restores file content; (b) `diffFull(from, to)` returns `Snapshot.FileDiff[]`; (c) `Session.fork` clones messages strictly before `messageID` into a new session and preserves `parentID` lineage; (d) `step-start`/`step-finish` snapshot hashes on parts are real shadow-git hashes recoverable by `Snapshot.restore`; (e) `SessionContextEpoch.reset` deletes a seeded epoch row.

- [ ] **Step 1: Write the failing test** — `packages/opencode/test/snapshot/run07-characterize.test.ts`:

```ts
import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionContextEpochTable } from "@opencode-ai/core/session/sql"
import { SystemContext } from "@opencode-ai/core/system-context"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { Snapshot } from "@/snapshot"
import { MessageID, PartID } from "@/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, Snapshot.node, SessionProjector.node, Database.node, CrossSpawnSpawner.node]),
  ),
)

const ref = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") }
const write = (file: string, text: string) => Effect.promise(() => Bun.write(file, text))
const read = (file: string) => Effect.promise(() => Bun.file(file).text())

it.live(
  "track returns a stable tree hash; restore returns file content",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        yield* write(`${dir}/a.txt`, "A")
        const h1 = yield* snapshot.track()
        expect(h1).toBeTruthy()
        yield* write(`${dir}/a.txt`, "B")
        const h2 = yield* snapshot.track()
        expect(h2).not.toBe(h1)
        yield* snapshot.restore(h1!)
        expect(yield* read(`${dir}/a.txt`)).toBe("A")
      }),
    { git: true },
  ),
)

it.live(
  "diffFull reports status and counts between two tracked hashes",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        yield* write(`${dir}/grow.txt`, "one\n")
        const before = yield* snapshot.track()
        yield* write(`${dir}/grow.txt`, "one\ntwo\n")
        yield* write(`${dir}/added.txt`, "new")
        const after = yield* snapshot.track()
        const diffs = yield* snapshot.diffFull(before!, after!)
        expect(diffs.find((d) => d.file === "grow.txt")?.status).toBe("modified")
        expect(diffs.find((d) => d.file === "grow.txt")?.additions).toBe(1)
        expect(diffs.find((d) => d.file === "added.txt")?.status).toBe("added")
      }),
    { git: true },
  ),
)

it.live(
  "Session.fork clones messages strictly before the boundary and keeps parent lineage",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const info = yield* session.create({})
        const sid = info.id
        const u1 = yield* session.updateMessage({
          id: MessageID.ascending(), role: "user", sessionID: sid, agent: "default", model: ref,
          time: { created: Date.now() },
        })
        yield* session.updatePart({ id: PartID.ascending(), messageID: u1.id, sessionID: sid, type: "text", text: "one" })
        const u2 = yield* session.updateMessage({
          id: MessageID.ascending(), role: "user", sessionID: sid, agent: "default", model: ref,
          time: { created: Date.now() },
        })
        yield* session.updatePart({ id: PartID.ascending(), messageID: u2.id, sessionID: sid, type: "text", text: "two" })
        const fork = yield* session.fork({ sessionID: sid, messageID: u2.id })
        const msgs = yield* session.messages({ sessionID: fork.id })
        expect(msgs.length).toBe(1)
        // fork re-ids cloned messages: only the pre-boundary message survives, under a fresh id
        expect(msgs[0].info.id).not.toBe(u1.id)
        expect(msgs[0].parts[0].text).toBe("one")
        expect(fork.id).not.toBe(sid)
      }),
    { git: true },
  ),
)

it.live(
  "part snapshot hashes are recoverable tree hashes",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const snapshot = yield* Snapshot.Service
        yield* write(`${dir}/a.txt`, "v1")
        const before = yield* snapshot.track()
        yield* write(`${dir}/a.txt`, "v2")
        const info = yield* session.create({})
        const u = yield* session.updateMessage({
          id: MessageID.ascending(), role: "user", sessionID: info.id, agent: "default", model: ref,
          time: { created: Date.now() },
        })
        yield* session.updatePart({ id: PartID.ascending(), messageID: u.id, sessionID: info.id, type: "step-start", snapshot: before })
        yield* snapshot.restore(before!)
        expect(yield* read(`${dir}/a.txt`)).toBe("v1")
      }),
    { git: true },
  ),
)

it.live(
  "SessionContextEpoch.reset removes a seeded epoch row",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const session = yield* Session.Service
        const info = yield* session.create({})
        yield* SessionContextEpoch.initialize(db, Effect.succeed(SystemContext.empty), info.id)
        const seeded = yield* db.select().from(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, info.id)).get()
        expect(seeded).toBeDefined()
        yield* SessionContextEpoch.reset(db, info.id)
        const after = yield* db.select().from(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, info.id)).get()
        expect(after).toBeUndefined()
      }),
    { git: true },
  ),
)
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd packages/opencode && bun test test/snapshot/run07-characterize.test.ts`
Expected: FAIL at the first `it.live` (module resolves; assertion fails or instance error). If the file does not even run, that is still a valid failing baseline — record the actual failure in the Deviation Log.

- [ ] **Step 3: Fix the test to match reality (the test pins *existing* behavior; the real code wins)**

The test asserts existing behavior, so "implementation" here means correcting any excerpt that drifted from the real modules (message ID brand helpers, `Session.create` input shape, `Bun.$` availability). If a characterization differs from the excerpt, the real module wins: update this file's excerpt, keep the intent, record the deviation. Do NOT add product code in this task.

- [ ] **Step 4: Run it, watch it pass** — same command as Step 2. Expected: 5 pass.

- [ ] **Step 5: Typecheck** — `cd packages/opencode && bun typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/test/snapshot/run07-characterize.test.ts
git commit -m "test(opencode): characterize snapshot/fork/epoch primitives for RUN-07"
```

---

### Task 2: Journaled ExperimentCheckpoint records (sidecar + client + mark/list service)

**Files:**
- Modify: `crates/ultracode-events/src/event.rs` (two additive `EventKind` variants)
- Modify: `crates/ultracode-events/src/projections.rs` (two tables, `index_record` cases, `list_experiment_checkpoints`, tests)
- Modify: `crates/ultracode-events/src/rpc.rs` (`list_experiment_checkpoints` dispatch)
- Modify: `packages/ultracode-events-client/src/index.ts` (`listExperimentCheckpoints` + `ExperimentCheckpointRecord` type)
- Create: `packages/ultracode-events-client/test/experiment.test.ts`
- Create: `packages/opencode/src/snapshot/experiment.ts` (`ExperimentCheckpoint.Service` mark/list + `ExperimentJournal` + adapter)
- Create: `packages/opencode/test/snapshot/lib/experiment-journal.ts` (shared real-sidecar journal layer, reused by Tasks 3–5)
- Create: `packages/opencode/test/snapshot/experiment.test.ts`

**Interfaces:**
- Consumes: `Snapshot.track()` (Task 1-a); `proposeCommit(key, kind)` + `fromTransport`/`start` (client); `EventKind` serde shape (Context File 9).
- Produces:
  - Rust `EventKind::ExperimentCheckpointCreated { session_id, checkpoint_id, snapshot_hash, message_id, label: Option<String>, created_by: String, test_summary: Option<String> }` and `EventKind::ExperimentRetained { session_id, checkpoint_id, candidates: Vec<String>, retained_by: String, at_ms: u64 }`.
  - Rust projections `list_experiment_checkpoints(session_id: &str) -> Result<Vec<ExperimentCheckpointRow>, rusqlite::Error>` where `ExperimentCheckpointRow = { session_id, checkpoint_id, snapshot_hash, message_id, label: Option<String>, created_by, test_summary: Option<String>, seq: u64, retained: Option<{ retained_by, at_ms, candidates: Vec<String> }> }`.
  - RPC `list_experiment_checkpoints` → `{ "data": [ ...rows ] }`; unknown/missing `session_id` → error string.
  - Client `listExperimentCheckpoints(sessionId: string): Promise<ExperimentCheckpointRecord[]>`; `ExperimentCheckpointRecord` mirrors the Rust row.
  - `ExperimentCheckpoint.Service` (`@opencode/ExperimentCheckpoint`): `mark(input: MarkInput): Effect.Effect<ExperimentCheckpointInfo>`, `list(sessionID: SessionID): Effect.Effect<ExperimentCheckpointInfo[]>`. `MarkInput = { sessionID, messageID, label?, createdBy: "model"|"user", testSummary? }`. `ExperimentCheckpointInfo = { checkpointID, sessionID, snapshotHash, messageID, label?, createdBy, testSummary?, retained? }`.
  - `ExperimentCheckpoint.ExperimentJournal` service: `commit(key, kind): Effect.Effect<{seq,hash,duplicate}>`, `list(sessionID): Effect.Effect<ExperimentCheckpointInfo[]>`; `adapterFromEventsClient(client)` factory.
  - Tagged errors `ExperimentCheckpointNotFoundError`, `ExperimentCheckpointUnavailableError`.

**Journaling justification (record in the plan's DoD review):** the one-owner rule (README §2.4, audit §27.2) makes the sidecar the single journal. Experiment *provenance* (who created, what was retained, from which candidates) is audit data and must live in the journal, not in a TS-owned second store. The *conversation* fork is session lineage and lives in EventV2 (projected from `SessionV1.Event.Created`/`MessageUpdated`). The sidecar changes are strictly additive: two new serde variants and one new RPC — no existing envelope semantics change. TS writes only through `propose_commit` idempotency keys (`experiment:<sessionID>:<checkpointID>`, replay-safe through the RUN-01 supervisor).

- [ ] **Step 1: Write the failing Rust test** — in `crates/ultracode-events/src/projections.rs` test module (after `write_journal`, `:1286`), add:

```rust
fn write_experiment_journal(dir: &std::path::Path) {
    let mut j = JournalWriter::create(dir, "ses_1").unwrap();
    j.append(EventKind::SessionStarted { client: "t".into(), client_version: "0".into() }, None).unwrap();
    j.append(
        EventKind::ExperimentCheckpointCreated {
            session_id: "ses_abc".into(),
            checkpoint_id: "ckpt_1".into(),
            snapshot_hash: "1111111".into(),
            message_id: "msg_9".into(),
            label: Some("variant A".into()),
            created_by: "model".into(),
            test_summary: Some("3 passed".into()),
        },
        None,
    )
    .unwrap();
    j.append(
        EventKind::ExperimentRetained {
            session_id: "ses_abc".into(),
            checkpoint_id: "ckpt_1".into(),
            candidates: vec!["ckpt_1".into(), "ckpt_2".into()],
            retained_by: "user".into(),
            at_ms: 42,
        },
        None,
    )
    .unwrap();
    j.commit_boundary().unwrap();
}

#[test]
fn experiment_checkpoints_list_joins_created_and_retained() {
    let jdir = dir("exp-j");
    let dbdir = dir("exp-db");
    let _ = std::fs::remove_dir_all(&jdir);
    let _ = std::fs::remove_dir_all(&dbdir);
    std::fs::create_dir_all(&dbdir).unwrap();
    write_experiment_journal(&jdir);
    let mut store = ProjectionStore::open(&dbdir.join("proj.db")).unwrap();
    store.rebuild(&jdir, "ses_1").unwrap();
    let rows = store.list_experiment_checkpoints("ses_abc").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].checkpoint_id, "ckpt_1");
    assert_eq!(rows[0].snapshot_hash, "1111111");
    assert_eq!(rows[0].created_by, "model");
    assert_eq!(rows[0].test_summary.as_deref(), Some("3 passed"));
    let retained = rows[0].retained.as_ref().expect("retained block");
    assert_eq!(retained.retained_by, "user");
    assert_eq!(retained.candidates, vec!["ckpt_1", "ckpt_2"]);
    let _ = std::fs::remove_dir_all(&jdir);
    let _ = std::fs::remove_dir_all(&dbdir);
}
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cargo test -p ultracode-events --lib experiment_checkpoints` (from repo root).
Expected: compile error — `EventKind::ExperimentCheckpointCreated` does not exist.

- [ ] **Step 3: Implement the Rust side**

`event.rs` — add after `WorkspaceSnapshotCreated { ... }` (keep the enum grouped by domain; additive only):

```rust
ExperimentCheckpointCreated {
    session_id: String,
    checkpoint_id: String,
    snapshot_hash: String,
    message_id: String,
    #[serde(default)]
    label: Option<String>,
    created_by: String,
    #[serde(default)]
    test_summary: Option<String>,
},
ExperimentRetained {
    session_id: String,
    checkpoint_id: String,
    candidates: Vec<String>,
    retained_by: String,
    at_ms: u64,
},
```

`projections.rs`:
- In the schema-init block (after the `events_index` table ~`:221`), add:

```sql
CREATE TABLE IF NOT EXISTS experiment_checkpoints (
  session_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  message_id TEXT NOT NULL,
  label TEXT,
  created_by TEXT NOT NULL,
  test_summary TEXT,
  seq INTEGER NOT NULL,
  PRIMARY KEY (session_id, checkpoint_id)
);
CREATE TABLE IF NOT EXISTS experiment_retained (
  session_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  retained_by TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  candidates TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (session_id, checkpoint_id)
);
```

- In `index_record` (after the memory cases, `:476`), add:

```rust
EventKind::ExperimentCheckpointCreated { session_id, checkpoint_id, snapshot_hash, message_id, label, created_by, test_summary } => {
    self.conn.execute(
        "INSERT OR REPLACE INTO experiment_checkpoints (session_id, checkpoint_id, snapshot_hash, message_id, label, created_by, test_summary, seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![session_id, checkpoint_id, snapshot_hash, message_id, label, created_by, test_summary, record.event.seq],
    )?;
}
EventKind::ExperimentRetained { session_id, checkpoint_id, candidates, retained_by, at_ms } => {
    self.conn.execute(
        "INSERT OR REPLACE INTO experiment_retained (session_id, checkpoint_id, retained_by, at_ms, candidates, seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![session_id, checkpoint_id, retained_by, at_ms, serde_json::to_string(candidates).map_err(|_| rusqlite::Error::InvalidParameterName("retain candidates".into()))?, record.event.seq],
    )?;
}
```

- Add a row type and query (public, used by rpc.rs):

```rust
pub struct ExperimentCheckpointRow {
    pub session_id: String,
    pub checkpoint_id: String,
    pub snapshot_hash: String,
    pub message_id: String,
    pub label: Option<String>,
    pub created_by: String,
    pub test_summary: Option<String>,
    pub seq: u64,
    pub retained: Option<ExperimentRetainedRow>,
}
pub struct ExperimentRetainedRow {
    pub retained_by: String,
    pub at_ms: u64,
    pub candidates: Vec<String>,
}

pub fn list_experiment_checkpoints(&self, session_id: &str) -> Result<Vec<ExperimentCheckpointRow>, rusqlite::Error> {
    let mut stmt = self.conn.prepare(
        "SELECT c.session_id, c.checkpoint_id, c.snapshot_hash, c.message_id, c.label, c.created_by, c.test_summary, c.seq, r.retained_by, r.at_ms, r.candidates
         FROM experiment_checkpoints c LEFT JOIN experiment_retained r
           ON r.session_id = c.session_id AND r.checkpoint_id = c.checkpoint_id
         WHERE c.session_id = ?1 ORDER BY c.seq ASC",
    )?;
    let rows = stmt.query_map(params![session_id], |row| {
        let retained_by: Option<String> = row.get(8)?;
        let at_ms: Option<u64> = row.get(9)?;
        let candidates: Option<String> = row.get(10)?;
        Ok(ExperimentCheckpointRow {
            session_id: row.get(0)?,
            checkpoint_id: row.get(1)?,
            snapshot_hash: row.get(2)?,
            message_id: row.get(3)?,
            label: row.get(4)?,
            created_by: row.get(5)?,
            test_summary: row.get(6)?,
            seq: row.get(7)?,
            retained: match (retained_by, at_ms, candidates) {
                (Some(retained_by), Some(at_ms), Some(candidates)) => Some(ExperimentRetainedRow {
                    retained_by,
                    at_ms,
                    candidates: serde_json::from_str(&candidates).unwrap_or_default(),
                }),
                _ => None,
            },
        })
    })?;
    rows.collect()
}
```

`rpc.rs` — in `dispatch`, after `"list_events"`:

```rust
"list_experiment_checkpoints" => {
    let session_id = req.params.get("session_id").and_then(|v| v.as_str()).ok_or("missing session_id")?;
    let rows = state.projections.list_experiment_checkpoints(session_id)?;
    Ok(json!({ "data": rows }))
}
```

- [ ] **Step 4: Run Rust tests + clippy, watch pass**

Run: `cargo test -p ultracode-events` then `cargo clippy -p ultracode-events -- -D warnings`
Expected: both green; the new test passes.

- [ ] **Step 5: Write the failing TS client test** — `packages/ultracode-events-client/test/experiment.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { EventsClient } from "../src"

// Real sidecar required: cargo build -p ultracode-events first.
const bin = process.env.ULTRACODE_EVENTS_SIDECAR_BIN ?? "target/debug/sidecar"
let client: EventsClient

describe("experiment checkpoint journal", () => {
  beforeAll(async () => {
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const path = await import("node:path")
    const dir = mkdtempSync(path.join(tmpdir(), "exp-client-"))
    client = EventsClient.start({
      sidecarBin: bin,
      journalDir: dir,
      db: path.join(dir, "proj.db"),
      artifacts: path.join(dir, "artifacts"),
      session: "ses_sidecar",
    })
    await client.ping()
  })
  afterAll(async () => {
    client?.kill()
  })

  test("propose created + retained and list joins them", async () => {
    const created = await client.proposeCommit("experiment:ses_abc:ckpt_1", {
      kind: "experiment-checkpoint-created",
      data: {
        session_id: "ses_abc",
        checkpoint_id: "ckpt_1",
        snapshot_hash: "1111111",
        message_id: "msg_9",
        label: "variant A",
        created_by: "model",
        test_summary: "3 passed",
      },
    })
    expect(created.duplicate).toBe(false)
    await client.proposeCommit("experiment:ses_abc:ckpt_1:retain", {
      kind: "experiment-retained",
      data: {
        session_id: "ses_abc",
        checkpoint_id: "ckpt_1",
        candidates: ["ckpt_1", "ckpt_2"],
        retained_by: "user",
        at_ms: 42,
      },
    })
    const rows = await client.listExperimentCheckpoints("ses_abc")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.snapshot_hash).toBe("1111111")
    expect(rows[0]!.retained?.retained_by).toBe("user")
    expect(rows[0]!.retained?.candidates).toEqual(["ckpt_1", "ckpt_2"])
  })

  test("propose_commit is idempotent by key", async () => {
    const again = await client.proposeCommit("experiment:ses_abc:ckpt_1", {
      kind: "experiment-checkpoint-created",
      data: { session_id: "ses_abc", checkpoint_id: "ckpt_1", snapshot_hash: "1111111", message_id: "msg_9", created_by: "model" },
    })
    expect(again.duplicate).toBe(true)
  })
})
```

- [ ] **Step 6: Run it, watch it fail**

Run: `cd packages/ultracode-events-client && bun test test/experiment.test.ts`
Expected: FAIL — `listExperimentCheckpoints` is not a function; and the first test's `proposeCommit` may reject if the running sidecar predates the new variants (rebuild the binary before Step 8).

- [ ] **Step 7: Implement the client** — `packages/ultracode-events-client/src/index.ts`: add the `ExperimentCheckpointRecord`/`ExperimentRetainedRecord` types near the other record types, and a method after `replay`:

```ts
export type ExperimentRetainedRecord = { retained_by: string; at_ms: number; candidates: string[] }
export type ExperimentCheckpointRecord = {
  session_id: string
  checkpoint_id: string
  snapshot_hash: string
  message_id: string
  label: string | null
  created_by: string
  test_summary: string | null
  seq: number
  retained: ExperimentRetainedRecord | null
}
// on EventsClient:
async listExperimentCheckpoints(sessionId: string): Promise<ExperimentCheckpointRecord[]> {
  return (await this.call("list_experiment_checkpoints", { session_id: sessionId })) as { data: ExperimentCheckpointRecord[] }
    .data
}
```

Rebuild the sidecar so the TS test runs against the new RPC: `cargo build -p ultracode-events`.

- [ ] **Step 8: Run it, watch pass** — same command as Step 6. Expected: 2 pass. Then `cd packages/ultracode-events-client && bun typecheck`.

- [ ] **Step 9: Write the failing opencode service test** — `packages/opencode/test/snapshot/experiment.test.ts`:

```ts
import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { Snapshot } from "@/snapshot"
import { ExperimentCheckpoint } from "@/snapshot/experiment"
import { MessageID, SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { journalLayer } from "./lib/experiment-journal"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([ExperimentCheckpoint.node, Snapshot.node, CrossSpawnSpawner.node])),
    journalLayer,
  ),
)

const write = (file: string, text: string) => Effect.promise(() => Bun.write(file, text))

it.instance(
  "mark captures the current worktree tree hash and list returns the record",
  Effect.gen(function* () {
    const test = yield* TestInstance
    const snap = yield* Snapshot.Service
    const experiment = yield* ExperimentCheckpoint.Service
    const sessionID = SessionID.make("ses_abc")
    yield* write(`${test.directory}/experiment-a.txt`, "v1")
    const h1 = yield* snap.track()
    expect(h1).toBeTruthy()
    const info = yield* experiment.mark({
      sessionID,
      messageID: MessageID.make("msg_9"),
      createdBy: "model",
      label: "variant A",
    })
    expect(info.snapshotHash).toBe(h1)
    expect(info.checkpointID).toMatch(/^ckpt_/)
    const listed = yield* experiment.list(sessionID)
    expect(listed.find((c) => c.checkpointID === info.checkpointID)?.snapshotHash).toBe(h1)
  }),
  { git: true },
)

it.instance(
  "mark with snapshots disabled fails with ExperimentCheckpointUnavailableError",
  Effect.gen(function* () {
    const experiment = yield* ExperimentCheckpoint.Service
    const sessionID = SessionID.make("ses_abc")
    const error = yield* experiment
      .mark({ sessionID, messageID: MessageID.make("msg_9"), createdBy: "model" })
      .pipe(Effect.flip)
    expect(error._tag).toBe("ExperimentCheckpointUnavailableError")
  }),
  { git: true, config: { snapshot: false } },
)
```

The shared `journalLayer` lives in `packages/opencode/test/snapshot/lib/experiment-journal.ts` (created in this task — Tasks 3–5 import it):

```ts
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventsClient } from "@ultracode/events-client"
import { Effect, Layer } from "effect"
import { ExperimentCheckpoint } from "@/snapshot/experiment"

// Real sidecar required: cargo build -p ultracode-events first.
const sidecarBin = process.env.ULTRACODE_EVENTS_SIDECAR_BIN ?? "target/debug/sidecar"

export const journalLayer = Layer.effect(
  ExperimentCheckpoint.ExperimentJournal,
  Effect.gen(function* () {
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const path = await import("node:path")
    const dir = mkdtempSync(path.join(tmpdir(), "exp-opencode-"))
    const client = EventsClient.start({
      sidecarBin,
      journalDir: dir,
      db: path.join(dir, "proj.db"),
      artifacts: path.join(dir, "artifacts"),
      session: "ses_sidecar",
    })
    return yield* ExperimentCheckpoint.adapterFromEventsClient(client)
  }),
)
```

- [ ] **Step 10: Run it, watch it fail**

Run: `cd packages/opencode && bun test test/snapshot/experiment.test.ts`
Expected: FAIL — module `@/snapshot/experiment` does not exist. (Note: the second test's `{ config: { snapshot: false } }` fixture option must be verified against `fixture/fixture.ts`; if unsupported, drive the disabled path differently — see Deviation Log.)

- [ ] **Step 11: Implement `packages/opencode/src/snapshot/experiment.ts`**

Module shape per `packages/opencode/AGENTS.md`: flat exports + `export * as ExperimentCheckpoint from "./experiment"` at the bottom. Effect service pattern from `snapshot/index.ts`:

```ts
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Hash } from "@opencode-ai/core/util/hash"
import { Context, Effect, Layer, Schema } from "effect"
import { Snapshot } from "@/snapshot"
import { MessageID, SessionID } from "@/session/schema"

export const MarkInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  label: Schema.optional(Schema.String),
  createdBy: Schema.Literal("model", "user"),
  testSummary: Schema.optional(Schema.String),
})
export type MarkInput = Schema.Schema.Type<typeof MarkInput>

export const ExperimentCheckpointInfo = Schema.Struct({
  checkpointID: Schema.String,
  sessionID: SessionID,
  snapshotHash: Schema.String,
  messageID: MessageID,
  label: Schema.optional(Schema.String),
  createdBy: Schema.Literal("model", "user"),
  testSummary: Schema.optional(Schema.String),
  retained: Schema.optional(
    Schema.Struct({
      retainedBy: Schema.Literal("model", "user"),
      atMs: Schema.Number,
      candidates: Schema.Array(Schema.String),
    }),
  ),
})
export type ExperimentCheckpointInfo = Schema.Schema.Type<typeof ExperimentCheckpointInfo>

export class ExperimentCheckpointNotFoundError extends Schema.TaggedErrorClass<ExperimentCheckpointNotFoundError>()(
  "ExperimentCheckpointNotFoundError",
  { sessionID: SessionID, checkpointID: Schema.String },
) {}
export class ExperimentCheckpointUnavailableError extends Schema.TaggedErrorClass<ExperimentCheckpointUnavailableError>()(
  "ExperimentCheckpointUnavailableError",
  { sessionID: SessionID, reason: Schema.String },
) {}

export interface ExperimentJournal {
  readonly commit: (key: string, kind: unknown) => Effect.Effect<{ seq: number; hash: string; duplicate: boolean }>
  readonly list: (sessionID: string) => Effect.Effect<JournalCheckpointRow[]>
}

/** Raw sidecar projection row (snake_case, as `list_experiment_checkpoints` returns it). */
export interface JournalCheckpointRow {
  readonly session_id: string
  readonly checkpoint_id: string
  readonly snapshot_hash: string
  readonly message_id: string
  readonly label: string | null
  readonly created_by: string
  readonly test_summary: string | null
  readonly seq: number
  readonly retained: { readonly retained_by: string; readonly at_ms: number; readonly candidates: readonly string[] } | null
}
export class ExperimentJournal extends Context.Service<ExperimentJournal, ExperimentJournal>()(
  "@opencode/ExperimentJournal",
) {}

export interface Interface {
  readonly mark: (input: MarkInput) => Effect.Effect<ExperimentCheckpointInfo>
  readonly list: (sessionID: SessionID) => Effect.Effect<ExperimentCheckpointInfo[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ExperimentCheckpoint") {}

export function adapterFromEventsClient(client: {
  proposeCommit(key: string, kind: unknown): Promise<{ seq: number; hash: string; duplicate: boolean }>
  listExperimentCheckpoints(sessionID: string): Promise<JournalCheckpointRow[]>
}) {
  return ExperimentJournal.of({
    commit: (key, kind) => Effect.promise(() => client.proposeCommit(key, kind)),
    list: (sessionID) => Effect.promise(() => client.listExperimentCheckpoints(sessionID)),
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const snap = yield* Snapshot.Service
    const journal = yield* ExperimentJournal

    const mark = Effect.fn("ExperimentCheckpoint.mark")(function* (input: MarkInput) {
      const snapshotHash = yield* snap.track()
      if (!snapshotHash) {
        return yield* new ExperimentCheckpointUnavailableError({
          sessionID: input.sessionID,
          reason: "snapshots are disabled or the project is not a git repo",
        })
      }
      const checkpointID = `ckpt_${Hash.fast(`${input.sessionID}\0${input.messageID}\0${snapshotHash}`)}`
      yield* journal.commit(`experiment:${input.sessionID}:${checkpointID}`, {
        kind: "experiment-checkpoint-created",
        data: {
          session_id: input.sessionID,
          checkpoint_id: checkpointID,
          snapshot_hash: snapshotHash,
          message_id: input.messageID,
          label: input.label ?? null,
          created_by: input.createdBy,
          test_summary: input.testSummary ?? null,
        },
      })
      return {
        checkpointID,
        sessionID: input.sessionID,
        snapshotHash,
        messageID: input.messageID,
        label: input.label,
        createdBy: input.createdBy,
        testSummary: input.testSummary,
      }
    })

    const list = Effect.fn("ExperimentCheckpoint.list")(function* (sessionID: SessionID) {
      const rows = yield* journal.list(sessionID)
      return rows.map((row) => ({
        checkpointID: row.checkpoint_id,
        sessionID: SessionID.make(row.session_id),
        snapshotHash: row.snapshot_hash,
        messageID: MessageID.make(row.message_id),
        label: row.label ?? undefined,
        createdBy: row.created_by === "user" ? ("user" as const) : ("model" as const),
        testSummary: row.test_summary ?? undefined,
        retained: row.retained
          ? {
              retainedBy: row.retained.retained_by === "user" ? ("user" as const) : ("model" as const),
              atMs: row.retained.at_ms,
              candidates: [...row.retained.candidates],
            }
          : undefined,
      }))
    })

    return Service.of({ mark, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Snapshot.node] })

export * as ExperimentCheckpoint from "."
```

If `Hash.fast` is not exported from `@opencode-ai/core/util/hash` with that signature, generate the checkpoint id with `MessageID`-style ascending or a `crypto.randomUUID()`-free short hash — verify while implementing (Context File 1 uses `Hash.fast(ctx.worktree)`, so the import path is confirmed).

- [ ] **Step 12: Run it, watch pass; then typecheck**

Run: `cd packages/opencode && bun test test/snapshot/experiment.test.ts` → 2 pass. Then `cd packages/opencode && bun typecheck`.

- [ ] **Step 13: Commit**

```bash
git add crates/ultracode-events/src/event.rs crates/ultracode-events/src/projections.rs crates/ultracode-events/src/rpc.rs
git add packages/ultracode-events-client/src/index.ts packages/ultracode-events-client/test/experiment.test.ts
git add packages/opencode/src/snapshot/experiment.ts packages/opencode/test/snapshot/lib/experiment-journal.ts packages/opencode/test/snapshot/experiment.test.ts
git commit -m "feat(ultracode-events): journal experiment checkpoint provenance with sidecar records"
```

---

### Task 3: Branch-from-checkpoint (fork + restore + optional isolated worktree)

**Files:**
- Create: `packages/opencode/src/snapshot/experiment-branch.ts`
- Create: `packages/opencode/test/snapshot/experiment-branch.test.ts`

**Interfaces:**
- Consumes: `ExperimentCheckpoint.Service.list` (Task 2); `Session.fork` (Context File 4); `Snapshot.restore` (Task 1-a); `Worktree.Service` (`makeWorktreeInfo`/`createFromInfo`/`remove`); `InstanceRuntime.load` + `InstanceRef` (Context Files 17–18).
- Produces: `ExperimentBranch.Service` (`@opencode/ExperimentBranch`) with `branch(input: BranchInput): Effect.Effect<BranchResult>`. `BranchInput = { sessionID: SessionID, checkpointID: string, isolated?: boolean }`. `BranchResult = { forkSessionID: SessionID, directory: string }`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { Snapshot } from "@/snapshot"
import { ExperimentCheckpoint } from "@/snapshot/experiment"
import { ExperimentBranch } from "@/snapshot/experiment-branch"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { TestInstance, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { journalLayer } from "./lib/experiment-journal"

const ref = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") }

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        ExperimentBranch.node,
        ExperimentCheckpoint.node,
        Snapshot.node,
        Session.node,
        Worktree.node,
        Database.node,
        CrossSpawnSpawner.node,
      ]),
    ),
    journalLayer,
  ),
)

const write = (file: string, text: string) => Effect.promise(() => Bun.write(file, text))
const read = (file: string) => Effect.promise(() => Bun.file(file).text())

it.instance(
  "branch restores the checkpoint state and forks the conversation at the boundary",
  Effect.gen(function* () {
    const test = yield* TestInstance
    const session = yield* Session.Service
    const experiment = yield* ExperimentCheckpoint.Service
    const branch = yield* ExperimentBranch.Service

    yield* write(`${test.directory}/a.txt`, "A0")
    const info = yield* session.create({})
    const sid = info.id
    const u1 = yield* session.updateMessage({
      id: MessageID.ascending(), role: "user", sessionID: sid, agent: "default", model: ref,
      time: { created: Date.now() },
    })
    yield* session.updatePart({ id: PartID.ascending(), messageID: u1.id, sessionID: sid, type: "text", text: "first" })
    const ck = yield* experiment.mark({ sessionID: sid, messageID: u1.id, createdBy: "model", label: "baseline" })
    yield* write(`${test.directory}/a.txt`, "A1")
    const u2 = yield* session.updateMessage({
      id: MessageID.ascending(), role: "user", sessionID: sid, agent: "default", model: ref,
      time: { created: Date.now() },
    })
    yield* session.updatePart({ id: PartID.ascending(), messageID: u2.id, sessionID: sid, type: "text", text: "second" })

    const out = yield* branch.branch({ sessionID: sid, checkpointID: ck.checkpointID })
    expect(out.forkSessionID).not.toBe(sid)
    expect(yield* read(`${test.directory}/a.txt`)).toBe("A0")
    const msgs = yield* session.messages({ sessionID: out.forkSessionID })
    expect(msgs.length).toBe(1)
    // fork re-ids cloned messages; only the pre-boundary turn survives
    expect(msgs[0].parts[0].text).toBe("first")
  }),
  { git: true },
)

it.live(
  "isolated branch restores into a fresh worktree and leaves the primary untouched",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const experiment = yield* ExperimentCheckpoint.Service
        const branch = yield* ExperimentBranch.Service
        const worktree = yield* Worktree.Service

        yield* write(`${dir}/a.txt`, "A0")
        const info = yield* session.create({})
        const sid = info.id
        const u1 = yield* session.updateMessage({
          id: MessageID.ascending(), role: "user", sessionID: sid, agent: "default", model: ref,
          time: { created: Date.now() },
        })
        yield* session.updatePart({ id: PartID.ascending(), messageID: u1.id, sessionID: sid, type: "text", text: "first" })
        const ck = yield* experiment.mark({ sessionID: sid, messageID: u1.id, createdBy: "model" })
        yield* write(`${dir}/a.txt`, "A1")

        const out = yield* branch.branch({ sessionID: sid, checkpointID: ck.checkpointID, isolated: true })
        expect(out.directory).not.toBe(dir)
        expect(yield* read(`${dir}/a.txt`)).toBe("A1")
        expect(yield* read(`${out.directory}/a.txt`)).toBe("A0")
        yield* worktree.remove({ directory: out.directory })
      }),
    { git: true },
  ),
)
```

(The `journalLayer` above is imported from `test/snapshot/lib/experiment-journal.ts`, created in Task 2. `TestInstance` comes from `../fixture/fixture`.)

- [ ] **Step 2: Run it, watch it fail**

Run: `cd packages/opencode && bun test test/snapshot/experiment-branch.test.ts`
Expected: FAIL — module `@/snapshot/experiment-branch` does not exist.

- [ ] **Step 3: Implement `packages/opencode/src/snapshot/experiment-branch.ts`**

```ts
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Snapshot } from "@/snapshot"
import { ExperimentCheckpoint } from "@/snapshot/experiment"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceRuntime } from "@/project/instance-runtime"

export const BranchInput = Schema.Struct({
  sessionID: SessionID,
  checkpointID: Schema.String,
  isolated: Schema.optional(Schema.Boolean),
})
export type BranchInput = Schema.Schema.Type<typeof BranchInput>

export const BranchResult = Schema.Struct({
  forkSessionID: SessionID,
  directory: Schema.String,
})
export type BranchResult = Schema.Schema.Type<typeof BranchResult>

export interface Interface {
  readonly branch: (input: BranchInput) => Effect.Effect<BranchResult>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ExperimentBranch") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const ck = yield* ExperimentCheckpoint.Service
    const snap = yield* Snapshot.Service
    const session = yield* Session.Service
    const worktree = yield* Worktree.Service

    const branch = Effect.fn("ExperimentBranch.branch")(function* (input: BranchInput) {
      const record = (yield* ck.list(input.sessionID)).find((c) => c.checkpointID === input.checkpointID)
      if (!record) {
        return yield* new ExperimentCheckpoint.ExperimentCheckpointNotFoundError({
          sessionID: input.sessionID,
          checkpointID: input.checkpointID,
        })
      }
      const forkSessionID = (yield* session.fork({ sessionID: input.sessionID, messageID: record.messageID })).id

      if (input.isolated) {
        const info = yield* worktree.makeWorktreeInfo({
          name: `experiment-${encodeBranch(String(input.sessionID))}-${encodeBranch(input.checkpointID)}`,
        })
        yield* worktree.createFromInfo(info)
        const loaded = yield* Effect.promise(() => InstanceRuntime.load({ directory: info.directory }))
        yield* snap.restore(record.snapshotHash).pipe(Effect.provideService(InstanceRef, loaded))
        return { forkSessionID, directory: info.directory }
      }

      yield* snap.restore(record.snapshotHash)
      const current = yield* InstanceRef
      if (!current) return yield* Effect.fail(new Error("ExperimentBranch.branch requires an active instance"))
      return { forkSessionID, directory: current.directory }
    })

    return Service.of({ branch })
  }),
)

function encodeBranch(value: string) {
  return value.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 24)
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [ExperimentCheckpoint.node, Snapshot.node, Session.node, Worktree.node],
})

export * as ExperimentBranch from "."
```

Notes for the implementer: `InstanceRuntime.load({ directory })` is a real production instance load (Context File 17) — verify its exact `LoadInput` shape; if it requires project config the scheduler does not, fall back to restoring into the primary instance and record the deviation (isolated restore is secondary to the fork+restore contract). `Worktree.makeWorktreeInfo` may require the source repo to be a git worktree-capable repo — the `{ git: true }` fixture satisfies this; verify `createFromInfo` returns before the worktree is ready and whether the scheduler's `watchReady` must be awaited (Context File 6 does await readiness — if the isolated test flakes on "not ready", await `info.directory` existence before restore).

- [ ] **Step 4: Run it, watch pass; then typecheck**

Run: `cd packages/opencode && bun test test/snapshot/experiment-branch.test.ts` → 2 pass. Then `cd packages/opencode && bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/snapshot/experiment-branch.ts packages/opencode/test/snapshot/experiment-branch.test.ts
git commit -m "feat(opencode): branch sessions from experiment checkpoints with optional worktree isolation"
```

---

### Task 4: Compare API (`diffFull` + summary)

**Files:**
- Create: `packages/opencode/src/snapshot/experiment-compare.ts`
- Create: `packages/opencode/test/snapshot/experiment-compare.test.ts`

**Interfaces:**
- Consumes: `ExperimentCheckpoint.Service.list` (Task 2); `Snapshot.diffFull` (Task 1-b); `Snapshot.FileDiff` (`@opencode-ai/schema/file-diff` Info).
- Produces: `ExperimentCompare.Service` (`@opencode/ExperimentCompare`) with `compare(input: CompareInput): Effect.Effect<ExperimentCompareResult>`. `CompareInput = { sessionID, from: string, to: string }` (`from`/`to` are checkpointIDs). `ExperimentCompareResult = { from: ExperimentCheckpointInfo, to: ExperimentCheckpointInfo, diffs: Snapshot.FileDiff[], summary: { additions: number, deletions: number, files: number } }`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { Snapshot } from "@/snapshot"
import { ExperimentCheckpoint } from "@/snapshot/experiment"
import { ExperimentCompare } from "@/snapshot/experiment-compare"
import { MessageID, SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { journalLayer } from "./lib/experiment-journal"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([ExperimentCompare.node, ExperimentCheckpoint.node, Snapshot.node, CrossSpawnSpawner.node]),
    ),
    journalLayer,
  ),
)

const write = (file: string, text: string) => Effect.promise(() => Bun.write(file, text))

it.instance(
  "compare reports diffFull plus a numeric summary between two checkpoints",
  Effect.gen(function* () {
    const test = yield* TestInstance
    const experiment = yield* ExperimentCheckpoint.Service
    const compare = yield* ExperimentCompare.Service
    const sessionID = SessionID.make("ses_abc")

    yield* write(`${test.directory}/base.txt`, "BASE\n")
    const a = yield* experiment.mark({ sessionID, messageID: MessageID.make("msg_1"), createdBy: "model", label: "A" })
    yield* write(`${test.directory}/base.txt`, "BASE\nfeature-a\n")
    yield* write(`${test.directory}/a.txt`, "A")
    const b = yield* experiment.mark({ sessionID, messageID: MessageID.make("msg_2"), createdBy: "model", label: "B" })

    const out = yield* compare.compare({ sessionID, from: a.checkpointID, to: b.checkpointID })
    expect(out.from.label).toBe("A")
    expect(out.to.label).toBe("B")
    const base = out.diffs.find((d) => d.file === "base.txt")
    expect(base?.status).toBe("modified")
    expect(base?.additions).toBe(1)
    expect(out.diffs.find((d) => d.file === "a.txt")?.status).toBe("added")
    expect(out.summary).toEqual({
      additions: 2,
      deletions: 0,
      files: 2,
    })
  }),
  { git: true },
)

it.instance(
  "compare with unknown checkpoint fails with ExperimentCheckpointNotFoundError",
  Effect.gen(function* () {
    const compare = yield* ExperimentCompare.Service
    const sessionID = SessionID.make("ses_abc")
    const a = yield* (yield* ExperimentCheckpoint.Service).mark({
      sessionID,
      messageID: MessageID.make("msg_1"),
      createdBy: "model",
    })
    const error = yield* compare
      .compare({ sessionID, from: a.checkpointID, to: "ckpt_missing" })
      .pipe(Effect.flip)
    expect(error._tag).toBe("ExperimentCheckpointNotFoundError")
  }),
  { git: true },
)
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd packages/opencode && bun test test/snapshot/experiment-compare.test.ts`
Expected: FAIL — module `@/snapshot/experiment-compare` does not exist (and `./lib/experiment-journal` may not exist yet — create it as part of Step 1 by extracting the real-sidecar journal layer from `experiment.test.ts`).

- [ ] **Step 3: Implement `packages/opencode/src/snapshot/experiment-compare.ts`**

```ts
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Snapshot } from "@/snapshot"
import { ExperimentCheckpoint } from "@/snapshot/experiment"
import { SessionID } from "@/session/schema"

export const CompareInput = Schema.Struct({
  sessionID: SessionID,
  from: Schema.String,
  to: Schema.String,
})
export type CompareInput = Schema.Schema.Type<typeof CompareInput>

export const ExperimentCompareResult = Schema.Struct({
  from: ExperimentCheckpoint.ExperimentCheckpointInfo,
  to: ExperimentCheckpoint.ExperimentCheckpointInfo,
  diffs: Schema.Array(Snapshot.FileDiff),
  summary: Schema.Struct({
    additions: Schema.Number,
    deletions: Schema.Number,
    files: Schema.Number,
  }),
})
export type ExperimentCompareResult = Schema.Schema.Type<typeof ExperimentCompareResult>

export interface Interface {
  readonly compare: (input: CompareInput) => Effect.Effect<ExperimentCompareResult>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ExperimentCompare") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const ck = yield* ExperimentCheckpoint.Service
    const snap = yield* Snapshot.Service

    const compare = Effect.fn("ExperimentCompare.compare")(function* (input: CompareInput) {
      const records = yield* ck.list(input.sessionID)
      const from = records.find((c) => c.checkpointID === input.from)
      const to = records.find((c) => c.checkpointID === input.to)
      if (!from) {
        return yield* new ExperimentCheckpoint.ExperimentCheckpointNotFoundError({
          sessionID: input.sessionID,
          checkpointID: input.from,
        })
      }
      if (!to) {
        return yield* new ExperimentCheckpoint.ExperimentCheckpointNotFoundError({
          sessionID: input.sessionID,
          checkpointID: input.to,
        })
      }
      const diffs = yield* snap.diffFull(from.snapshotHash, to.snapshotHash)
      return {
        from,
        to,
        diffs,
        summary: {
          additions: diffs.reduce((sum, d) => sum + d.additions, 0),
          deletions: diffs.reduce((sum, d) => sum + d.deletions, 0),
          files: diffs.length,
        },
      }
    })

    return Service.of({ compare })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [ExperimentCheckpoint.node, Snapshot.node],
})

export * as ExperimentCompare from "."
```

- [ ] **Step 4: Run it, watch pass; then typecheck**

Run: `cd packages/opencode && bun test test/snapshot/experiment-compare.test.ts` → 2 pass. Then `cd packages/opencode && bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/snapshot/experiment-compare.ts packages/opencode/test/snapshot/experiment-compare.test.ts packages/opencode/test/snapshot/lib/experiment-journal.ts packages/opencode/test/snapshot/experiment.test.ts packages/opencode/test/snapshot/experiment-branch.test.ts
git commit -m "feat(opencode): compare experiment checkpoints with diffFull and summary"
```

---

### Task 5: Retain with provenance journaling

**Files:**
- Modify: `packages/opencode/src/snapshot/experiment.ts` (add `retain` to `Interface`; `list` already carries `retained`)
- Create: `packages/opencode/test/snapshot/experiment-retain.test.ts`

**Interfaces:**
- Consumes: `ExperimentJournal.commit` (Task 2); `ExperimentCheckpoint.list` retained shape (Task 2).
- Produces: `ExperimentCheckpoint.Service.retain(input: RetainInput): Effect.Effect<void>` where `RetainInput = { sessionID: SessionID, checkpointID: string, retainedBy: "model"|"user", candidates: string[] }`. Semantics: journal an `experiment-retained` record (idempotency key `experiment:<sessionID>:<checkpointID>:retain`); a subsequent `list` returns the checkpoint with `retained` populated; re-retaining the same checkpoint updates the retained block (key dedupe at the sidecar keeps one retained row per checkpoint, `INSERT OR REPLACE`).

- [ ] **Step 1: Write the failing test**

```ts
import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { Snapshot } from "@/snapshot"
import { ExperimentCheckpoint } from "@/snapshot/experiment"
import { MessageID, SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { journalLayer } from "./lib/experiment-journal"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([ExperimentCheckpoint.node, Snapshot.node, CrossSpawnSpawner.node])),
    journalLayer,
  ),
)

const write = (file: string, text: string) => Effect.promise(() => Bun.write(file, text))

it.instance(
  "retain journals provenance and list returns the retained block",
  Effect.gen(function* () {
    const test = yield* TestInstance
    const experiment = yield* ExperimentCheckpoint.Service
    const sessionID = SessionID.make("ses_abc")

    yield* write(`${test.directory}/a.txt`, "v1")
    const a = yield* experiment.mark({ sessionID, messageID: MessageID.make("msg_1"), createdBy: "model", label: "A" })
    yield* write(`${test.directory}/a.txt`, "v2")
    const b = yield* experiment.mark({ sessionID, messageID: MessageID.make("msg_2"), createdBy: "model", label: "B" })

    yield* experiment.retain({
      sessionID,
      checkpointID: b.checkpointID,
      retainedBy: "user",
      candidates: [a.checkpointID, b.checkpointID],
    })

    const listed = yield* experiment.list(sessionID)
    const winner = listed.find((c) => c.checkpointID === b.checkpointID)
    expect(winner?.retained?.retainedBy).toBe("user")
    expect(winner?.retained?.candidates).toEqual([a.checkpointID, b.checkpointID])
    expect(listed.find((c) => c.checkpointID === a.checkpointID)?.retained).toBeUndefined()
  }),
  { git: true },
)

it.instance(
  "retain of an unknown checkpoint fails with ExperimentCheckpointNotFoundError",
  Effect.gen(function* () {
    const experiment = yield* ExperimentCheckpoint.Service
    const sessionID = SessionID.make("ses_abc")
    const error = yield* experiment
      .retain({ sessionID, checkpointID: "ckpt_missing", retainedBy: "model", candidates: [] })
      .pipe(Effect.flip)
    expect(error._tag).toBe("ExperimentCheckpointNotFoundError")
  }),
  { git: true },
)
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd packages/opencode && bun test test/snapshot/experiment-retain.test.ts`
Expected: FAIL — `experiment.retain` is not a function.

- [ ] **Step 3: Implement `retain` in `experiment.ts`**

Add `RetainInput` schema and extend the interface + layer (the second test also needs `retain` to validate the checkpoint exists first):

```ts
export const RetainInput = Schema.Struct({
  sessionID: SessionID,
  checkpointID: Schema.String,
  retainedBy: Schema.Literal("model", "user"),
  candidates: Schema.Array(Schema.String),
})
export type RetainInput = Schema.Schema.Type<typeof RetainInput>
```

In `Interface` add: `readonly retain: (input: RetainInput) => Effect.Effect<void>`

In the layer closure:

```ts
const retain = Effect.fn("ExperimentCheckpoint.retain")(function* (input: RetainInput) {
  const rows = yield* journal.list(input.sessionID)
  if (!rows.some((row) => row.checkpoint_id === input.checkpointID)) {
    return yield* new ExperimentCheckpointNotFoundError({
      sessionID: input.sessionID,
      checkpointID: input.checkpointID,
    })
  }
  yield* journal.commit(`experiment:${input.sessionID}:${input.checkpointID}:retain`, {
    kind: "experiment-retained",
    data: {
      session_id: input.sessionID,
      checkpoint_id: input.checkpointID,
      candidates: input.candidates,
      retained_by: input.retainedBy,
      at_ms: Date.now(),
    },
  })
})
```

Return `Service.of({ mark, list, retain })`. The retained block already surfaces via `list`'s projection mapping (Task 2) — verify the sidecar `list_experiment_checkpoints` join surfaces the new row after `propose_commit` (it should, since `index_record` upserts the retained row).

- [ ] **Step 4: Run it, watch pass; then typecheck**

Run: `cd packages/opencode && bun test test/snapshot/experiment-retain.test.ts` → 2 pass. Then `cd packages/opencode && bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/snapshot/experiment.ts packages/opencode/test/snapshot/experiment-retain.test.ts
git commit -m "feat(opencode): retain experiment checkpoints with provenance journaling"
```

---

### Task 6: Unified rewind surface (`Rewind.rewind` — files + conversation + epoch)

**Files:**
- Create: `packages/opencode/src/snapshot/rewind.ts`
- Create: `packages/opencode/test/snapshot/rewind.test.ts`

**Interfaces:**
- Consumes: `SessionRevert.revert` (Context File 2); `SessionContextEpoch.reset` (Task 1-e); `Database.Service` (Context File 15 pattern: `(yield* Database.Service).db`).
- Produces: `Rewind.Service` (`@opencode/Rewind`) with `rewind(input: RewindInput): Effect.Effect<Session.Info, Session.BusyError>`. `RewindInput = { sessionID: SessionID, messageID: MessageID, partID?: PartID }`. Semantics — one gesture that (1) restores files + removes messages after the boundary (delegated to `SessionRevert.revert`, which stages the boundary and publishes the V1 diff event), (2) resets the context epoch so a fresh baseline renders on the next turn (`SessionContextEpoch.reset(db, sessionID)`), (3) returns the session info. UI/HTTP wiring is deliberately out of scope (deferred to RUN-12); this task ships and documents the client method only.

- [ ] **Step 1: Write the failing test** — model on `revert-compact.test.ts`:

```ts
import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionContextEpochTable } from "@opencode-ai/core/session/sql"
import { SystemContext } from "@opencode-ai/core/system-context"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { Snapshot } from "@/snapshot"
import { Rewind } from "@/snapshot/rewind"
import { MessageID, PartID } from "@/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionRevert.node,
      Snapshot.node,
      SessionProjector.node,
      Database.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)

const ref = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") }
const write = (file: string, text: string) => Effect.promise(() => Bun.write(file, text))
const read = (file: string) => Effect.promise(() => Bun.file(file).text())
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

it.live(
  "rewind restores files, removes later messages, and resets the context epoch",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const rewind = yield* Rewind.Service
        const snapshot = yield* Snapshot.Service
        const db = (yield* Database.Service).db

        yield* write(`${dir}/a.txt`, "A0")
        yield* write(`${dir}/b.txt`, "B0")
        const info = yield* session.create({})
        const sid = info.id

        const turn = Effect.fn("test.turn")(function* (file: string, next: string) {
          const u = yield* session.updateMessage({
            id: MessageID.ascending(), role: "user", sessionID: sid, agent: "default", model: ref,
            time: { created: Date.now() },
          })
          const a = yield* session.updateMessage({
            id: MessageID.ascending(), role: "assistant", sessionID: sid, agent: "default", parentID: u.id,
            path: { cwd: dir, root: dir }, cost: 0, tokens, modelID: ref.modelID,
            providerID: ref.providerID, time: { created: Date.now() }, finish: "end_turn",
          })
          const before = yield* snapshot.track()
          yield* session.updatePart({ id: PartID.ascending(), messageID: a.id, sessionID: sid, type: "step-start", snapshot: before })
          yield* write(`${dir}/${file}`, next)
          const after = yield* snapshot.track()
          const patch = yield* snapshot.patch(before!)
          yield* session.updatePart({ id: PartID.ascending(), messageID: a.id, sessionID: sid, type: "step-finish", snapshot: after, reason: "stop", cost: 0, tokens })
          yield* session.updatePart({ id: PartID.ascending(), messageID: a.id, sessionID: sid, type: "patch", hash: patch.hash, files: patch.files })
          return u.id
        })

        const first = yield* turn("a.txt", "A1")
        yield* turn("b.txt", "B2")

        // Seed a real epoch row so the reset is observable.
        yield* SessionContextEpoch.initialize(db, Effect.succeed(SystemContext.empty), sid)

        yield* rewind.rewind({ sessionID: sid, messageID: first })

        expect(yield* read(`${dir}/a.txt`)).toBe("A0")
        expect(yield* read(`${dir}/b.txt`)).toBe("B0")
        const msgs = yield* session.messages({ sessionID: sid })
        expect(msgs.length).toBe(0)
        const epoch = yield* db.select().from(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, sid)).get()
        expect(epoch).toBeUndefined()
      }),
    { git: true },
  ),
)
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd packages/opencode && bun test test/snapshot/rewind.test.ts`
Expected: FAIL — module `@/snapshot/rewind` does not exist.

- [ ] **Step 3: Implement `packages/opencode/src/snapshot/rewind.ts`**

```ts
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { Database } from "@opencode-ai/core/database/database"
import { Context, Effect, Layer, Schema } from "effect"
import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { MessageID, PartID, SessionID } from "@/session/schema"

export const RewindInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RewindInput = Schema.Schema.Type<typeof RewindInput>

export interface Interface {
  readonly rewind: (input: RewindInput) => Effect.Effect<Session.Info, Session.BusyError>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/Rewind") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const revertSvc = yield* SessionRevert.Service
    const { db } = yield* Database.Service

    const rewind = Effect.fn("Rewind.rewind")(function* (input: RewindInput) {
      const info = yield* revertSvc.revert(input)
      // Reset the context epoch so the next turn renders a fresh baseline from
      // the reverted conversation instead of the pre-rewind snapshot.
      yield* SessionContextEpoch.reset(db, input.sessionID)
      return info
    })

    return Service.of({ rewind })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [SessionRevert.node, Database.node],
})

export * as Rewind from "."
```

- [ ] **Step 4: Run it, watch pass; then typecheck**

Run: `cd packages/opencode && bun test test/snapshot/rewind.test.ts` → 1 pass. Then `cd packages/opencode && bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/snapshot/rewind.ts packages/opencode/test/snapshot/rewind.test.ts
git commit -m "feat(opencode): unified rewind gesture composing files, conversation, and context epoch"
```

---

### Task 7: `experiment_checkpoint` tool + docs + ledger

**Files:**
- Create: `packages/opencode/src/tool/experiment.ts` (`ExperimentTool`, id `experiment_checkpoint`, permission `experiment`)
- Modify: `packages/opencode/src/tool/registry.ts` (register the tool)
- Create: `packages/opencode/test/tool/experiment.test.ts`
- Modify: `opencode/TODO/README.md` (run ledger §8 + confirm registry §7 row)

**Interfaces:**
- Consumes: `ExperimentCheckpoint.Service.mark/list` (Tasks 2, 5); `Tool.define`/`Tool.init`/`Tool.Context` (Context File 12); `ctx.ask` permission gate (Context File 13); registry builtin block (Context File 14).
- Produces: `ExperimentTool` with `Parameters = { action: "mark" | "list", label?: string }`; tool id `experiment_checkpoint`; permission id `experiment`; `list` output renders each checkpoint `checkpoint_id`, `label`, `created_by`, `snapshot_hash`, `retained` marker. Docs: README ledger row; registry §7 row confirmed (already present — verify it names `packages/opencode/src/snapshot/*`).

- [ ] **Step 1: Write the failing tool test**

```ts
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Tool } from "@/tool/tool"
import { ExperimentTool } from "@/tool/experiment"
import { ExperimentCheckpoint } from "@/snapshot/experiment"
import { Snapshot } from "@/snapshot"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { journalLayer } from "../snapshot/lib/experiment-journal"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Agent.node,
        Truncate.node,
        Session.node,
        Database.node,
        ExperimentCheckpoint.node,
        Snapshot.node,
        CrossSpawnSpawner.node,
      ]),
    ),
    journalLayer,
  ),
)

describe("experiment_checkpoint parameters", () => {
  const decode = Schema.decodeUnknownSync(ExperimentTool.Parameters)
  test("accepts mark with optional label", () => {
    expect(decode({ action: "mark", label: "vA" })).toEqual({ action: "mark", label: "vA" })
  })
  test("accepts list", () => {
    expect(decode({ action: "list" })).toEqual({ action: "list" })
  })
  test("rejects unknown action", () => {
    expect(() => decode({ action: "explode" })).toThrow()
  })
})

it.instance(
  "mark requests permission 'experiment' and reports the checkpoint id",
  Effect.gen(function* () {
    const info = yield* ExperimentTool
    const def = yield* info.init()
    let requested: string | undefined
    const result = yield* def.execute(
      { action: "mark", label: "variant" },
      {
        sessionID: SessionID.make("ses_abc"),
        messageID: MessageID.make("msg_9"),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: (req: { permission: string }) =>
          Effect.sync(() => {
            requested = req.permission
          }),
      },
    )
    expect(requested).toBe("experiment")
    expect(result.output).toContain("ckpt_")
  }),
  { git: true },
)
```

(The `ctx.ask` contract accepts `Omit<PermissionV1.Request, "id" | "sessionID" | "tool">` — the recording closure above asserts the tool requests permission id `"experiment"`. `it.instance` already provides the tmp git instance that `Snapshot.track()` needs.)

If the tool test's ctx shape needs adjustment (`Tool.Context` fields `extra`, `callID` optional), verify against `tool/tool.ts` and `code-mode.test.ts` conventions; the real code wins. The `ask` assertion records the requested permission id — the tool must gate on `permission: "experiment"`.

- [ ] **Step 2: Run it, watch it fail**

Run: `cd packages/opencode && bun test test/tool/experiment.test.ts`
Expected: FAIL — module `@/tool/experiment` does not exist.

- [ ] **Step 3: Implement `packages/opencode/src/tool/experiment.ts`**

```ts
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { ExperimentCheckpoint } from "@/snapshot/experiment"

export const Parameters = Schema.Struct({
  action: Schema.Literal("mark", "list"),
  label: Schema.optional(Schema.String),
})

export const ExperimentTool = Tool.define(
  "experiment_checkpoint",
  Effect.gen(function* () {
    const experiment = yield* ExperimentCheckpoint.Service

    const render = (rows: ExperimentCheckpoint.ExperimentCheckpointInfo[]) =>
      rows
        .map(
          (row) =>
            `<checkpoint id="${row.checkpointID}" created_by="${row.createdBy}" hash="${row.snapshotHash}">${row.label ?? ""}${row.retained ? " [retained]" : ""}</checkpoint>`,
        )
        .join("\n")

    return {
      description: "Create or list experiment checkpoints. A checkpoint records the current workspace tree hash and its conversation anchor; branch from it to try alternative implementations and retain the winner.",
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "experiment",
            patterns: ["*"],
            always: ["*"],
            metadata: { action: params.action },
          })
          if (params.action === "mark") {
            const info = yield* experiment.mark({
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              createdBy: "model",
              label: params.label,
            })
            return {
              title: "Checkpoint created",
              metadata: { checkpointID: info.checkpointID },
              output: `Checkpoint ${info.checkpointID} created at ${info.snapshotHash} for message ${ctx.messageID}.`,
            }
          }
          const rows = yield* experiment.list(ctx.sessionID)
          return {
            title: "Experiment checkpoints",
            metadata: { count: rows.length },
            output: rows.length ? render(rows) : "No experiment checkpoints yet.",
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as ExperimentTool from "./experiment"
```

The module shape must match how tools are registered: `Tool.init(experiment)` in the registry (Context File 14). If `ctx.ask`'s `PermissionV1.Request` omits `always`/`patterns` (check `permission-v1` schema — the task tool uses both), trim to the fields that typecheck; record the deviation.

- [ ] **Step 4: Register the tool** — `packages/opencode/src/tool/registry.ts`: import `{ ExperimentTool } from "./experiment"`, add `experiment: Tool.init(experiment)` to the `Effect.all` block (after `plan`), and add `tool.experiment` to the `builtin` array (Context File 14, `:204-239`).

- [ ] **Step 5: Run it, watch pass; then typecheck**

Run: `cd packages/opencode && bun test test/tool/experiment.test.ts` → pass. Then `cd packages/opencode && bun typecheck` (also `cd packages/ultracode-events-client && bun typecheck` for completeness).

- [ ] **Step 6: Docs + ledger** — `opencode/TODO/README.md`:
- Append the run ledger row (§8): `| RUN-07 | <date> | <commit range> | <baselines?> | <deviations> |`.
- Confirm the §7 registry row reads `RUN-07 | ExperimentCheckpoint + rewind surface | packages/opencode/src/snapshot/* | RUN-13, RUN-14` (update the location cell if the implementer placed interfaces elsewhere; record in the deviation log).

- [ ] **Step 7: Run the full RUN-07 test sweep**

Run (each from its package dir):
`cd packages/opencode && bun test test/snapshot/run07-characterize.test.ts test/snapshot/experiment.test.ts test/snapshot/experiment-branch.test.ts test/snapshot/experiment-compare.test.ts test/snapshot/experiment-retain.test.ts test/snapshot/rewind.test.ts test/tool/experiment.test.ts`
`cd packages/ultracode-events-client && bun test test/experiment.test.ts`
`cargo test -p ultracode-events` and `cargo clippy -p ultracode-events -- -D warnings`
Expected: all green. Then verify the DoD items (see Orchestrator Brief) with commands you ran.

- [ ] **Step 8: Commit**

```bash
git add packages/opencode/src/tool/experiment.ts packages/opencode/src/tool/registry.ts packages/opencode/test/tool/experiment.test.ts
git add opencode/TODO/README.md
git commit -m "feat(opencode): experiment_checkpoint tool gated on experiment permission"
```

---

## Run-Level Review Prompt (dispatch after Task 7)

```
Review the commits <list hashes> in /home/thymia/UltraCode-Planning/opencode
implementing RUN-07 (file: opencode/TODO/RUN-07-experiment-checkpoints.md).
Run-specific checks:
1. One-owner rule: every ExperimentCheckpoint record is journaled through the
   sidecar propose_commit idempotency key (experiment:<sessionID>:<checkpointID>);
   grep the diff for any TS code that writes journal or projection files directly.
2. Sidecar changes are additive only: two new EventKind variants + one new RPC;
   existing envelope/transition semantics unchanged. cargo test + clippy green.
3. No second snapshot system: checkpoint snapshotHash always comes from
   Snapshot.track(); diffFull is the only file-compare path.
4. V1 freeze: session/prompt.ts, processor.ts, session.ts untouched; all new
   behavior is new files under packages/opencode/src/snapshot/* and
   packages/opencode/src/tool/*. Session.fork / SessionRevert.revert are consumed,
   not modified.
5. Unified rewind composes exactly three things (files, conversation, epoch) via
   SessionRevert.revert + SessionContextEpoch.reset; epoch reset is observable
   (test seeds and deletes the session_context_epoch row).
6. Retain provenance carries who/when/candidates and is readable through
   list_experiment_checkpoints on the real sidecar.
7. Diff scope: only files declared in the run plan (plus the test/snapshot/lib
   extraction noted in the deviation log).
Then the generic checks from TODO/README.md §5.1 items 1–5.
Reply numbered findings, BLOCKER or MINOR, file:line. No edits.
```

## Deviation Log (fill during execution)

| Task | Deviation | Reason |
|---|---|---|
