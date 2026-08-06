export * as MemorySelect from "./select"

import { redactSecrets } from "@ultracode/memory"
import type { MemoryRecord } from "@ultracode/memory"

export const MAX_MEMORY_RECORDS = 5
export const MAX_MEMORY_BYTES_PER_RECORD = 4096
export const MAX_MEMORY_TOTAL_BYTES = 61440

export const TRUNCATION_MARKER = "\n[truncated]"

export interface SelectOptions {
  readonly maxRecords: number
  readonly maxBytesPerRecord: number
  readonly maxTotalBytes: number
  readonly now: number
}

export interface Selection {
  readonly records: MemoryRecord[]
  readonly omitted: number
}

export function selectForInjection(records: ReadonlyArray<MemoryRecord>, options: SelectOptions): Selection {
  if (records.length === 0) return { records: [], omitted: 0 }
  const ranked = records.toSorted(sortByFreshness(options))
  const selected = ranked.reduce(
    (acc, record) => {
      if (acc.records.length >= options.maxRecords) return { ...acc, omitted: acc.omitted + 1 }
      const capped = capRecord(record, options.maxBytesPerRecord)
      const bytes = recordBytes(capped)
      if (acc.total + bytes > options.maxTotalBytes) return { ...acc, omitted: acc.omitted + 1 }
      return { records: [...acc.records, capped], total: acc.total + bytes, omitted: acc.omitted }
    },
    { records: [] as MemoryRecord[], total: 0, omitted: 0 },
  )
  return { records: selected.records.map(redactRecord), omitted: selected.omitted }
}

function sortByFreshness(options: SelectOptions) {
  return (a: MemoryRecord, b: MemoryRecord) => {
    const ageA = options.now - recency(a)
    const ageB = options.now - recency(b)
    if (ageA !== ageB) return ageA - ageB
    if (a.threadId < b.threadId) return -1
    if (a.threadId > b.threadId) return 1
    return 0
  }
}

const recency = (record: MemoryRecord): number => record.lastUsage ?? record.sourceUpdatedAt

function capRecord(record: MemoryRecord, maxBytes: number): MemoryRecord {
  const text = record.rolloutSummary === "" ? record.rawMemory : `${record.rawMemory}\n${record.rolloutSummary}`
  if (byteLength(text) <= maxBytes) return record
  const budget = Math.max(0, maxBytes - byteLength(TRUNCATION_MARKER))
  return { ...record, rawMemory: `${truncateToBytes(text, budget)}${TRUNCATION_MARKER}`, rolloutSummary: "" }
}

function redactRecord(record: MemoryRecord): MemoryRecord {
  return { ...record, rawMemory: redactSecrets(record.rawMemory), rolloutSummary: redactSecrets(record.rolloutSummary) }
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length

const decoder = new TextDecoder()

function truncateToBytes(text: string, budget: number): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= budget) return text
  return decoder.decode(bytes.subarray(0, budget)).replace(/\uFFFD$/u, "")
}

function recordBytes(record: MemoryRecord): number {
  return byteLength(record.rawMemory) + byteLength(record.rolloutSummary)
}
