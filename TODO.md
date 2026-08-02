# UltraCode TODO

## Stage 7: Operational Read APIs and UI

- Add location-scoped, paged HTTP APIs for the durable agent DAG, task commands, and deliverables.
- Add location-scoped, paged HTTP APIs for approval decision/profile/grant history.
- Bridge sidecar artifact metadata/range reads and journal replay behind server APIs.
- Persist and serve prompt/context/token/cache/provider compatibility diagnostics.
- Add API models for plugin bundle health, provenance, skills, deferred discovery, and conflicts.
- Build lazy, virtualized app surfaces for the agent command center, task DAG, approval center, context/provider inspectors, artifact viewer, replay, and plugin manager.
- Add browser and performance coverage for paging, large lists, stable cursor merges, and action availability.

## Agent Control and Collaboration

- Add an "approve for me" permission level: route a proposed action from the primary task model to a separate review model, record the verdict, and preserve canonical policy as the final authority.
- Investigate Codex plugin support and attempt a compatible integration behind the existing plugin-bundle lifecycle.
- Add parallel/async subagent orchestration with explicit interaction tools: mailbox, evidence handoff, status inspection, cancellation, and bounded dependency waits.
- Add a beta multi-agent planning PoC where two or more models independently critique/debate a plan, produce bounded evidence, and the orchestrator selects or synthesizes a final plan.
- Let agents spawn subagents with explicit model/effort when the user requests it; otherwise inherit the current model/effort under scheduler limits.
- Add per-role default model/effort configuration for planning, orchestration, subagents, review, compaction, and synthesis.
- Add a Codex-inspired decision system: present no more than four options, preserve decision notes, and accept follow-up user constraints.
- Implement `/goal` as a durable goal/task entry point bound to the scheduler DAG.

## Agent Safety, Recovery, and Execution

- Add automatic rollback checkpoints for agent experiments. This is separate from user turn rollback: an agent can branch from a checkpoint, compare implementations, and retain the selected result with provenance.
- Add toggleable context snapshots before compaction, retaining the full pre-compaction context in the artifact store for inspection/recovery.
- Add persistent model-created terminals with explicit lifecycle ownership; only the model or user may terminate them, and the user can inspect/control them.
- Investigate Codex compaction behavior and compare it against the UltraCode staged compaction controller with conformance/evaluation cases.
- Add a further measured performance pass for startup, idle memory, event batching, renderer latency, and sidecar/process lifecycle.

## Computer Use and Browser Automation

- Port Codex-style computer use behind capability and sandbox gates.
- Add an app browser surface with DOM inspection, browser-console access, screenshots, and browser actions exposed as audited tools.
- Add Record & Replay: optionally record a screen session while the user talks, derive a bounded reusable computer-use skill, and allow the user to promote it to a global skill.

## Personalization and Memory

- Add opt-in personalized memory for user preferences, recurring workflows, and interaction style, with review/edit/delete controls and freshness/provenance metadata.
- Investigate a Claude-style background preference/memory consolidation flow, subject to explicit user controls and privacy boundaries.

## Import and Provenance Controls

- Before each Codex or Claude-derived implementation, complete a dependency-closure audit, record provenance/authorization, and port invariants rather than introducing a competing controller.

## Stage 6 Follow-Up: Native Windows Enforcement

- Complete capability-SID restricted-token enforcement with reversible ACL leases for approved writable roots; prove cleanup on launch failure, exit, termination, restart, and shutdown.
- Bind WFP IPv4/IPv6 outbound-connect rules to the per-sandbox identity, never an executable-wide rule; ship an idempotent elevated setup path and deny network-isolated launches until it is ready.
- Package and supervise the native broker and setup executable for CLI/Desktop; retain `ULTRACODE_SANDBOX_BROKER` only as a development override.
- Add Windows integration coverage for allowed writes, denied outside/junction/UNC/ADS writes, environment stripping, WFP IPv4/IPv6 denial, containment cleanup, and child/grandchild termination.
- Keep WSL, unsupported profiles, failed setup, and every unavailable containment control explicitly fail-closed.

## Runtime and Packaging

- Package the `ultracode-events` sidecar for CLI and desktop releases on all supported targets.
- Add startup supervision, restart/reconnect behavior, and bounded commit buffering for the sidecar runtime service.
- Add end-to-end recovery tests covering a task child, sidecar restart, worktree lease reconciliation, and terminal deliverable repair.

## Stage 8 and Stage 9

- Run the Tauri/Rust vertical-slice proof gates before committing to a desktop cutover.
- Add macOS/Linux sandbox, PTY, packaging, signing, updater, and crash-recovery parity after Windows gates pass.
