// Usage feedback loop (ported from Codex's post-run citation handling). After
// the model emits output, the harness parses citations, filters to thread ids
// known to the store, and credits them via recordUsage so they rank higher in
// future Phase 2 consolidation selection.

import { parseMemoryCitations, type MemoryCitation } from "./citations"
import type { MemoryStore } from "./store"

export interface FeedbackResult {
  readonly citations: readonly MemoryCitation[]
  readonly credited: readonly string[]
  readonly unknown: readonly string[]
}

// Apply usage feedback from a model output. Thread ids not present in the store
// are returned in `unknown` (the harness may log or surface them) — they are
// not silently dropped. Fails closed (no throws) on store errors.
export const applyFeedback = async (
  output: string,
  store: MemoryStore,
  atMs: number,
): Promise<FeedbackResult> => {
  const citations = parseMemoryCitations(output)
  const known = await store.list()
  const knownIds = new Set(known.map((r) => r.threadId))
  const credited: string[] = []
  const unknown: string[] = []
  for (const c of citations) {
    if (knownIds.has(c.threadId)) credited.push(c.threadId)
    else unknown.push(c.threadId)
  }
  if (credited.length > 0) await store.recordUsage(credited, atMs)
  return { citations, credited, unknown }
}
