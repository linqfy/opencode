# @ultracode/memory

Extraction, consolidation, storage, and retrieval of persistent memory for the agent.

Since RUN-02 the package is wired into the live session: the `core/memory` System Context source (see `packages/core/src/memory/README.md`) injects a compact memory digest into the model prompt each turn, and a sidecar worker extracts new memory records from session transcripts through the ultracode-events job queue.

## Injection caps

Every turn, at most `MAX_MEMORY_RECORDS = 5` records are injected, each capped at `MAX_MEMORY_BYTES_PER_RECORD = 4096` bytes, for a session-epoch budget of `MAX_MEMORY_TOTAL_BYTES = 61440` bytes (60 KB). Selection is deterministic: sort by freshness (most-recent first), then by key ascending. Records that overflow the caps are reported as `+N more memories` in the rendered digest. Enforced in `packages/core/src/memory/select.ts`; also enforced by the render layer via `MAX_MEMORY_LINES` / `MAX_MEMORY_BYTES`.

## Privacy defaults

- Redaction cannot be disabled. `redactSecrets` is applied on extraction (`packages/ultracode-memory/src/extract.ts`) and again on every injected record (`packages/core/src/memory/select.ts`).
- Memory is opt-in. Nothing is extracted or injected unless `memory.enabled` is set to `true` (default `false`).
- Project-scoped by default; global scope requires an explicit `memory.scope: "global"` in config.

## Durable store

Memory is not kept in the core process. It is the sidecar projection `memory_records` in the ultracode-events SQLite store, written by the memory job worker over `propose_commit`. The core `MemoryStoreService` is an in-memory projection of that durable store for the current process.

## Review API

The `server.memory` protocol group exposes a review surface backed by the sidecar RPCs `list_memory_records`, `get_memory_record`, `patch_memory_record`, and `delete_memory_record`:

- `GET /api/memory` — page over durable memory records
- `GET /api/memory/:threadID` — fetch one record
- `PATCH /api/memory/:threadID` — edit a record (records user provenance)
- `DELETE /api/memory/:threadID` — remove a record from future pages

Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/memory.ts`.
