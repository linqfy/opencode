// Query-time relevance retrieval (ported from Claude Code's
// memdir/findRelevantMemories.ts). LLM-as-ranker, NOT embedding-based: formats
// a manifest, asks an injected LLM selector for up to 5 filenames, validates
// them against the scanned set, and fails closed to [] on any error.

import { formatMemoryManifest } from "./scan"
import type { MemoryHeader, RelevantMemory } from "./types"

export const MAX_RELEVANT_MEMORIES = 5

// Injected LLM selector seam: given the query + manifest text, return up to 5
// selected filenames. Replaces Claude's `sideQuery` (LLM call with JSON-schema
// output { selected_memories: string[] }).
export type MemorySelector = (input: { query: string; manifest: string; recentTools: readonly string[] }) => Promise<string[]>

export const findRelevantMemories = async (
  query: string,
  memories: readonly MemoryHeader[],
  selectMemories: MemorySelector,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> => {
  const candidates = memories.filter((memory) => !alreadySurfaced.has(memory.filePath))
  if (candidates.length === 0) return []

  const manifest = formatMemoryManifest(candidates)
  let selectedFilenames: string[]
  try {
    selectedFilenames = await selectMemories({ query, manifest, recentTools })
  } catch {
    return []
  }

  const byFilename = new Map(candidates.map((memory) => [memory.filename, memory]))
  return selectedFilenames
    .map((filename) => byFilename.get(filename))
    .filter((memory): memory is MemoryHeader => memory !== undefined)
    .slice(0, MAX_RELEVANT_MEMORIES)
    .map((memory) => ({ path: memory.filePath, mtimeMs: memory.mtimeMs }))
}
