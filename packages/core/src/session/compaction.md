# V2 Compaction Controller

The V2 compaction controller (`packages/core/src/session/compaction.ts`) runs the staged
planner from `@ultracode/context` and persists a typed audit checkpoint alongside the
model-facing summary.

## Pipeline

`CompactionPipeline.run(dependencies, input)` is the controller's single entry — both the
preflight path (`compactIfNeeded`) and the provider-overflow path (`compactAfterOverflow`)
route through it exactly once. It runs `Planner.compactConversation`, which applies the
stages in order:

1. `dedupeIdenticalBlocks` — removes exact duplicate text blocks per message.
2. `replaceOversizedWithPreviews` — replaces tool results above `oversizedResultTokens`
   with a truncated preview that keeps the managed-output path reference.
3. `microCompact` — clears stale compactable tool results (keeps the last
   `keepRecentToolResults` + the recent tail + tagged parts), marking them with the
   `[Old tool result content cleared]` placeholder.
4. retoken — recomputes per-message token totals after clearing/preview.
5. summarize — the injected seam streams an anchored prompt (the previous
   summary admission line plus `checkpointPrompt`, which asks the model for the
   typed JSON checkpoint from `compaction-summarize.ts`) and parses the output.
   The parsed structured fields feed the audit checkpoint; the checkpoint's
   objective is the model-facing summary carried by the Compaction message, and
   unparseable output falls back to `fallbackCheckpoint` (compaction never
   fails).

Overflow semantics are unchanged: preflight estimate → compact-if-needed; provider
overflow → exactly one overflow-triggered compaction; a second overflow is terminal.

## Checkpoint

The typed `CompactionCheckpoint` (13 fields, see `@ultracode/context` `types.ts`) is the
structured audit twin of the summary. On `Compaction.Ended` the controller persists
`{ checkpoint, context_epoch, session_id, parent_compaction_sha? }` as canonical JSON to
the artifact store (retention `session`), and the durable Compaction message's metadata
carries the artifact sha as `checkpointSha`. Checkpoint persistence is best-effort: a
missing or failing store never fails compaction — the `Compaction.Ended` metadata carries
`checkpointLost: true` instead.

The store seam mirrors the memory-store pattern: core defines
`CompactionCheckpointStore.Service` with a default in-memory node; opencode replaces it
with a sidecar-backed node (`packages/opencode/src/session/compaction-checkpoint-store.ts`)
that writes through the scheduler's `putArtifact` — one artifact client, never a second
`EventsClient`.

## Snapshots

With `compaction.snapshot: true`, the controller captures the full pre-compaction
provider-request context `{ system, messages, tools }` from the unmutated request BEFORE
any stage mutation runs, persists it as a `session`-retention artifact, and names it on
the `Compaction.Started` event metadata as `preCompactionSnapshotSha`. Failure or absence
of the store records `snapshotLost: true`; compaction always proceeds.

## Cache-edit awareness

When the resolved model advertises `ModelCompatibility.cacheEdit`, the pipeline result
carries `{ kind: "cache-edit", partIds }` alongside the cleared state so the next request
can represent deletion provider-natively instead of mutating history text (which busts the
Anthropic prefix cache). The durable history records the same cleared state either way —
only the wire representation differs. `compactAfterOverflow` threads the ops onto its
return (`true` when there is nothing to emit, `{ cacheEdit }` when there is) so the runner
can reach them at the overflow boundary; the runner's existing truthiness check is
unaffected because the object is truthy.
