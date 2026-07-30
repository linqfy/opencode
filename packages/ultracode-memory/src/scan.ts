// Memory scanning (ported from Claude Code's memdir/memoryScan.ts). Reads each
// .md file's frontmatter into a MemoryHeader, sorted newest-first (cap 200).
// The filesystem is injected so the module stays pure.

import { parseMemoryFrontmatter } from "./frontmatter"
import type { MemoryHeader } from "./types"

export const MAX_MEMORY_FILES = 200

export const sortHeadersNewestFirst = (headers: readonly MemoryHeader[]): MemoryHeader[] =>
  [...headers].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_MEMORY_FILES)

export const formatMemoryManifest = (memories: readonly MemoryHeader[]): string =>
  memories
    .map((memory) => {
      const tag = memory.type ? `[${memory.type}] ` : ""
      const ts = new Date(memory.mtimeMs).toISOString()
      return memory.description
        ? `- ${tag}${memory.filename} (${ts}): ${memory.description}`
        : `- ${tag}${memory.filename} (${ts})`
    })
    .join("\n")

// Filesystem seam: list .md files (recursive) and read a file's head + mtime.
export interface MemoryFs {
  listMarkdownFiles: (memoryDir: string) => Promise<string[]>
  readFileHead: (filePath: string) => Promise<{ content: string; mtimeMs: number } | undefined>
}

// Scan a memory directory for .md files (excluding MEMORY.md), read their
// frontmatter, and return headers sorted newest-first (capped).
export const scanMemoryFiles = async (memoryDir: string, fs: MemoryFs): Promise<MemoryHeader[]> => {
  let files: string[]
  try {
    files = await fs.listMarkdownFiles(memoryDir)
  } catch {
    return []
  }
  const mdFiles = files.filter((file) => file.endsWith(".md") && !file.endsWith("MEMORY.md"))
  const results = await Promise.allSettled(
    mdFiles.map(async (relativePath): Promise<MemoryHeader | undefined> => {
      const filePath = `${memoryDir.replace(/\/$/, "")}/${relativePath}`
      const head = await fs.readFileHead(filePath)
      if (!head) return undefined
      const frontmatter = parseMemoryFrontmatter(head.content)
      return {
        filename: relativePath,
        filePath,
        mtimeMs: head.mtimeMs,
        description: frontmatter.description ?? null,
        type: frontmatter.type,
      }
    }),
  )
  const headers = results
    .filter((result): result is PromiseFulfilledResult<MemoryHeader | undefined> => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((header): header is MemoryHeader => header !== undefined)
  return sortHeadersNewestFirst(headers)
}
