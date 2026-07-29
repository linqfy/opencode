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
