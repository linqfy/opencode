# ultracode-events

The sole authoritative writer for canonical session state (spec §11). Append-only, hash-chained, segmented JSONL.

Invariants:

1. Existing lines are never modified. A corrupt FINAL record may be truncated only after checksum proof; corrupt earlier history is a fatal `CorruptHistory` error, never rewritten.
2. Chain hash: `sha256(prev_hash || "\n" || canonical_json(event))`. Canonical bytes come from declaration-order struct serialization with BTreeMap maps and integer timestamps only.
3. `JournalWriter.append` returns after a buffer flush. Durability exists only after `commit_boundary()` (`sync_data`). Everything past the last boundary is speculative.
4. Every command carries an idempotency key (`cmd` on the line). Recovery rebuilds the key index from the journal; no sidecar state file exists.
5. Segments rotate at `DEFAULT_MAX_SEGMENT_BYTES` with a terminal `segment-seal` record containing the final chain hash.

Layout: `event.rs` (schema + hashing), `journal.rs` (writer + rotation), `recovery.rs` (open/validate/truncate), `commit.rs` (idempotent `CommitLog`).

Next (Plan 2b): SQLite-WAL projections, artifact store, effect-ledger reconciliation. Next after that (Plan 2c): the JSON-RPC sidecar and Bun client.
