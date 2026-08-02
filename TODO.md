# UltraCode TODO

## Stage 7: Operational Read APIs and UI

- Add location-scoped, paged HTTP APIs for the durable agent DAG, task commands, and deliverables.
- Add location-scoped, paged HTTP APIs for approval decision/profile/grant history.
- Bridge sidecar artifact metadata/range reads and journal replay behind server APIs.
- Persist and serve prompt/context/token/cache/provider compatibility diagnostics.
- Add API models for plugin bundle health, provenance, skills, deferred discovery, and conflicts.
- Build lazy, virtualized app surfaces for the agent command center, task DAG, approval center, context/provider inspectors, artifact viewer, replay, and plugin manager.
- Add browser and performance coverage for paging, large lists, stable cursor merges, and action availability.

## Stage 6 Follow-Up: Native Windows Enforcement

- Implement the Windows broker backend behind `@ultracode/sandbox` using the approved dependency-closure and provenance process.
- Add Job Object process-tree containment, restricted-token/write-root enforcement, environment filtering, and network policy enforcement.
- Package and supervise the native broker; keep WSL and unsupported isolation profiles explicitly denied or degraded.
- Add Windows integration coverage for child/grandchild termination, path escapes, environment stripping, and containment failure modes.

## Runtime and Packaging

- Package the `ultracode-events` sidecar for CLI and desktop releases on all supported targets.
- Add startup supervision, restart/reconnect behavior, and bounded commit buffering for the sidecar runtime service.
- Add end-to-end recovery tests covering a task child, sidecar restart, worktree lease reconciliation, and terminal deliverable repair.

## Stage 8 and Stage 9

- Run the Tauri/Rust vertical-slice proof gates before committing to a desktop cutover.
- Add macOS/Linux sandbox, PTY, packaging, signing, updater, and crash-recovery parity after Windows gates pass.
