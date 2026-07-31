// Citation parser for memory usage feedback (ported from Codex's
// parse_skill_or_memory_calls semantics — model emits explicit citations in its
// output, the harness parses them and credits the memory store). Two formats
// are accepted; the harness prefers the explicit tag form and falls back to the
// bracket form for ergonomic compact citations.

import { MEMORY_CITATION_PATTERN } from "./patterns"

const MEMORY_BRACKET_PATTERN = /\[memory:([A-Za-z0-9_-]+)\]/g

export interface MemoryCitation {
  readonly threadId: string
  readonly path?: string
}

// Parse memory citations out of model output. Accepts two forms:
//   <memory-citation thread_id="..." path="..."/>
//   [memory:thread_id]
// Returns a deduplicated list preserving first-seen order. Malformed tags are
// ignored (no throw). The caller is responsible for verifying thread_id is
// known to the memory store before calling recordUsage.
export const parseMemoryCitations = (output: string): MemoryCitation[] => {
  const seen = new Set<string>()
  const out: MemoryCitation[] = []
  const push = (threadId: string, path?: string): void => {
    if (!threadId || seen.has(threadId)) return
    seen.add(threadId)
    out.push(path ? { threadId, path } : { threadId })
  }
  for (const match of output.matchAll(MEMORY_CITATION_PATTERN)) {
    const attrs = match.groups ?? {}
    const threadId = attrs.thread_id
    if (threadId) push(threadId, attrs.path)
  }
  for (const match of output.matchAll(MEMORY_BRACKET_PATTERN)) {
    const threadId = match[1]
    if (threadId) push(threadId)
  }
  return out
}
