import { redactSecrets } from "./extract"
import { rankForConsolidation, type MemoryRecord } from "./record"

export interface MemoryConsolidation {
  readonly summary: string
  readonly memory: string
  readonly sourceThreadIds: readonly string[]
}

export type MemoryConsolidator = (records: readonly MemoryRecord[]) => Promise<string>

export const CONSOLIDATION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    memory: { type: "string" },
    source_thread_ids: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "memory", "source_thread_ids"],
  additionalProperties: false,
} as const

export const consolidateMemory = async (
  records: readonly MemoryRecord[],
  consolidate: MemoryConsolidator,
): Promise<MemoryConsolidation | undefined> => {
  const selected = rankForConsolidation(records)
  try {
    const parsed = JSON.parse(await consolidate(selected)) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const output = parsed as Record<string, unknown>
    const keys = Object.keys(output)
    if (
      keys.length !== 3 ||
      !keys.every((key) => key === "summary" || key === "memory" || key === "source_thread_ids") ||
      typeof output.summary !== "string" ||
      typeof output.memory !== "string" ||
      !Array.isArray(output.source_thread_ids) ||
      !output.source_thread_ids.every((id) => typeof id === "string") ||
      (output.summary.trim().length === 0 && output.memory.trim().length === 0)
    ) {
      return undefined
    }
    const selectedIds = new Set(selected.map((record) => record.threadId))
    if (!output.source_thread_ids.every((id) => selectedIds.has(id))) return undefined
    return {
      summary: redactSecrets(output.summary),
      memory: redactSecrets(output.memory),
      sourceThreadIds: [...new Set(output.source_thread_ids)],
    }
  } catch {
    return undefined
  }
}
