// Durable memory store interface (the injectable storage seam; replaces Codex's
// MemoryStore/StateRuntime). An in-memory implementation is provided for tests;
// a SQLite-backed implementation is a follow-up.

import { rankForConsolidation, type MemoryRecord } from "./record"

export interface MemoryStore {
  upsert: (record: MemoryRecord) => Promise<void>
  list: () => Promise<MemoryRecord[]>
  recordUsage: (threadIds: readonly string[], atMs: number) => Promise<void>
  selectForConsolidation: (limit: number) => Promise<MemoryRecord[]>
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly records = new Map<string, MemoryRecord>()

  async upsert(record: MemoryRecord): Promise<void> {
    const existing = this.records.get(record.threadId)
    if (existing && existing.sourceUpdatedAt >= record.sourceUpdatedAt) return
    this.records.set(record.threadId, record)
  }

  async list(): Promise<MemoryRecord[]> {
    return Array.from(this.records.values())
  }

  async recordUsage(threadIds: readonly string[], atMs: number): Promise<void> {
    for (const threadId of threadIds) {
      const record = this.records.get(threadId)
      if (!record) continue
      this.records.set(threadId, { ...record, usageCount: record.usageCount + 1, lastUsage: atMs })
    }
  }

  async selectForConsolidation(limit: number): Promise<MemoryRecord[]> {
    return rankForConsolidation(Array.from(this.records.values())).slice(0, limit)
  }
}
