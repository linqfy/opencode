// Memory data model (ported from Claude Code's memdir/memoryTypes.ts).
// Four-type taxonomy; memory format is YAML frontmatter + markdown body.

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export const parseMemoryType = (raw: unknown): MemoryType | undefined => {
  if (typeof raw !== "string") return undefined
  return MEMORY_TYPES.find((type) => type === raw)
}

// A scanned memory file's header (frontmatter + filesystem metadata).
export interface MemoryHeader {
  readonly filename: string
  readonly filePath: string
  readonly mtimeMs: number
  readonly description: string | null
  readonly type: MemoryType | undefined
}

// A retrieved memory ready for injection.
export interface RelevantMemory {
  readonly path: string
  readonly mtimeMs: number
}

// A rendered memory message ready for the model context.
export interface RenderedMemory {
  readonly path: string
  readonly content: string
  readonly mtimeMs: number
  readonly header: string
}
