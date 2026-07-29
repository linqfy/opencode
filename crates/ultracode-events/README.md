# ultracode-events

The sole authoritative writer for canonical session state (spec §11). Append-only, hash-chained, segmented JSONL.

Invariants:

1. Existing lines are never modified. A corrupt FINAL record may be truncated only after checksum proof; corrupt earlier history is a fatal `CorruptHistory` error, never rewritten.
2. Chain hash: `sha256(prev_hash || "\n" || canonical_json(event))`. Canonical bytes come from declaration-order struct serialization with BTreeMap maps and integer timestamps only.
3. `JournalWriter.append` returns after a buffer flush. Durability exists only after `commit_boundary()` (`sync_data`). Everything past the last boundary is speculative.
4. Every command carries an idempotency key (`cmd` on the line). Recovery rebuilds the key index from the journal; no sidecar state file exists.
5. Segments rotate at `DEFAULT_MAX_SEGMENT_BYTES` with a terminal `segment-seal` record containing the final chain hash.

Layout: `event.rs` (schema + hashing), `journal.rs` (writer + rotation), `recovery.rs` (open/validate/truncate), `commit.rs` (idempotent `CommitLog`).

## Projections and artifacts (Stage 2b)

`projections.rs` maintains a SQLite-WAL `events_index` that is ALWAYS a projection of the journal — `rebuild` truncates and replays, so the journal is never second-guessed. Kind names are derived from the serde tag, so they cannot drift from the schema.

`artifacts.rs` is a content-addressed store: id = sha256(bytes) hex, bytes fsynced (temp + rename) before the metadata row is visible, identical bytes deduped to one blob. Retention classes are `turn`/`session`/`workspace`/`pinned`; eviction removes only expired + unreferenced + non-pinned artifacts. `NoPersist` credential artifacts store metadata only and fail `open_range`.

Next (Plan 2c): effect-ledger state machine and crash reconciliation. Next after that (Plan 2d): the JSON-RPC sidecar and Bun client.

Next (Plan 2b): SQLite-WAL projections, artifact store, effect-ledger reconciliation. Next after that (Plan 2c): the JSON-RPC sidecar and Bun client.

## Effect ledger and crash reconciliation (Stage 2c)

`effect.rs` implements the crash-safe side-effect protocol (spec §11). Effect state is a PURE projection over the journal — `fold_effects` replays `SideEffectPrepared/Dispatched/Observed/OutcomeUnknown` into one `EffectRecord` per idempotency key; there is no state file.

Reconciliation rules after a stop:
- `Observed` is the only terminal success (`NoAction`).
- A surviving `Prepared` from an UNCLEAN stop is "potentially dispatched".
- `Idempotent` effects → `Retry` (executor must prove no external outcome first).
- `Queryable` effects → `QueryExternal` (reconcile via external reference).
- `NeverRetry` effects in any non-terminal state → `RequireUserDecision` (never auto-retry).

Next (Plan 2d): the JSON-RPC sidecar process and Bun client. Next after that (Plan 2e): legacy OpenCode data import.

## Sidecar RPC and Bun client (Stage 2d)

`src/bin/sidecar.rs` hosts the whole event service and speaks newline-delimited JSON-RPC over stdio. Methods: `ping`, `propose_commit` (idempotent by key, indexes the projection before acking), `list_events`, `rebuild_projections`, `put_artifact`, `stat_artifact`, `open_range`, `reconcile_effects`. One JSON line in, one JSON line out; a request always yields exactly one response.

`client/events-client.ts` is the Bun-side half: it spawns the sidecar and exposes typed method calls. The sidecar is the sole journal writer; the client never touches the journal files.

State opens idempotently — a restart rebuilds projections and the effect index from the journal (proven by the restart integration test).

Deferred to runtime integration (Stage 3): MessagePack framing and credit-based backpressure (`worker.v1` hardening), Electron main-process supervision/respawn wiring, and routing the live session flow through the sidecar.

## Legacy import (Stage 2e)

`import.rs` + `src/bin/import-legacy.rs` import an existing OpenCode SQLite database (`session` + `session_message` tables) into the journal as `LegacySessionImported` / `LegacyMessageImported` events. OpenCode message `data` is carried as opaque raw JSON text — the importer never decodes OpenCode's schema, so fidelity is total and coupling is zero.

Guarantees:
- The source DB is opened READ-ONLY and never modified.
- Import is idempotent (deterministic propose keys `legacy-session-{id}` / `legacy-message-{id}`); re-runs skip already-imported rows.
- `--dry-run` reports counts without writing.
- A bad session/message is skipped and recorded in the report; it never aborts the import.

Usage: `import-legacy --source-db <opencode.db> --journal-dir <dir> [--session legacy] [--dry-run]`.

This completes Stage 2 (the durable event-service foundation). Stage 3 wires the live session flow through the sidecar and builds the prompt compiler / context planner.
