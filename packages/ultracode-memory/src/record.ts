// Durable memory record (ported from Codex's state/model/memories.rs
// Stage1Output + the DB-only usage columns). The durable store persists these
// and ranks them for consolidation.

export interface MemoryRecord {
  readonly threadId: string
  readonly sourceUpdatedAt: number
  readonly rawMemory: string
  readonly rolloutSummary: string
  readonly rolloutSlug?: string
  readonly cwd: string
  readonly gitBranch?: string
  readonly generatedAt: number
  readonly usageCount: number
  readonly lastUsage?: number
}

const hasContent = (record: MemoryRecord): boolean =>
  record.rawMemory.trim().length > 0 || record.rolloutSummary.trim().length > 0

const recency = (record: MemoryRecord): number => record.lastUsage ?? record.sourceUpdatedAt

const compareThreadIds = (a: string, b: string): number => {
  const aBytes = new TextEncoder().encode(a)
  const bBytes = new TextEncoder().encode(b)
  const length = Math.min(aBytes.length, bBytes.length)
  for (const index of Array.from({ length }, (_, index) => index)) {
    if (aBytes[index] !== bBytes[index]) return (bBytes[index] ?? 0) - (aBytes[index] ?? 0)
  }
  return bBytes.length - aBytes.length
}

// Rank records for consolidation: usage first (usage_count DESC), then recency
// (last_usage or source_updated_at DESC). Empty records are excluded. Ported
// from Codex's get_phase2_input_selection ranking.
export const rankForConsolidation = (records: readonly MemoryRecord[]): MemoryRecord[] =>
  records
    .filter(hasContent)
    .sort((a, b) => {
      if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount
      if (recency(b) !== recency(a)) return recency(b) - recency(a)
      if (b.sourceUpdatedAt !== a.sourceUpdatedAt) return b.sourceUpdatedAt - a.sourceUpdatedAt
      return compareThreadIds(a.threadId, b.threadId)
    })
