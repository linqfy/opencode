# Memory source

- Source key: `core/memory` (registered in `source.ts`, gated behind `memory.enabled`).
- Caps: ≤5 records/turn, ≤4KB/record, ≤60KB total per epoch; deterministic sort by freshness desc, key asc (`select.ts`).
- Epoch behavior: first load initializes the baseline; unchanged snapshots keep the stored baseline; updated snapshots publish a ContextUpdated text; removal emits "Previously loaded memory no longer applies."
- Config keys: `memory.enabled` (default `false`), `memory.scope` (`project` default | `global`).
- Durable store: sidecar projection `memory_records`; the production `MemoryStoreService` reads that projection through the events client (see `packages/opencode/src/memory/service.ts`), so deletes are reflected in the next epoch's block. Core tests inject an `InMemoryMemoryStore`.
