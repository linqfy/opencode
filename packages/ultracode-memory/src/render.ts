// Memory rendering for model injection (ported from Claude Code's
// attachments.ts readMemoriesForSurfacing + messages.ts relevant_memories).
// Reads each selected memory (200-line/4096-byte cap), adds a freshness header,
// and wraps it as a system-reminder user-meta message. File reading is injected.

import { memoryAge, memoryFreshnessNote } from "./age"
import type { RelevantMemory, RenderedMemory } from "./types"

export const MAX_MEMORY_LINES = 200
export const MAX_MEMORY_BYTES = 4096

// Injected file-content reader: returns the (already truncated) content + a
// truncated flag, or undefined if the file cannot be read.
export type MemoryContentReader = (
  path: string,
  limits: { maxLines: number; maxBytes: number },
) => Promise<{ content: string; truncated: boolean } | undefined>

const basename = (path: string): string => path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path

const memoryHeader = (path: string, mtimeMs: number): string => {
  const name = basename(path)
  return `Memory: ${name} (${memoryAge(mtimeMs)})`
}

// Render selected memories into system-reminder-wrapped messages.
export const renderMemoryMessages = async (
  memories: readonly RelevantMemory[],
  readContent: MemoryContentReader,
): Promise<RenderedMemory[]> => {
  const rendered: RenderedMemory[] = []
  for (const memory of memories) {
    const read = await readContent(memory.path, { maxLines: MAX_MEMORY_LINES, maxBytes: MAX_MEMORY_BYTES })
    if (!read) continue
    const header = memoryHeader(memory.path, memory.mtimeMs)
    const freshness = memoryFreshnessNote(memory.mtimeMs)
    const body = read.truncated
      ? `${read.content}\n[truncated — use the file read tool to see the full memory]`
      : read.content
    const content = `${freshness}<system-reminder>\n${header}\n\n${body}\n</system-reminder>`
    rendered.push({ path: memory.path, content, mtimeMs: memory.mtimeMs, header })
  }
  return rendered
}
