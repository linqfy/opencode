// YAML frontmatter parser for memory files (ported from Claude Code's
// frontmatterParser; dependency-free, uses Bun.YAML with a regex fallback).

import { parseMemoryType, type MemoryType } from "./types"

export interface MemoryFrontmatter {
  name?: string
  description?: string
  type?: MemoryType
  content: string
}

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/

const parseYaml = (text: string): Record<string, unknown> => {
  const yaml = (Bun as unknown as { YAML?: { parse: (input: string) => unknown } }).YAML
  if (yaml) {
    const parsed = yaml.parse(text)
    return (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>
  }
  const result: Record<string, unknown> = {}
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (match) result[match[1]] = match[2]
  }
  return result
}

export const parseMemoryFrontmatter = (markdown: string): MemoryFrontmatter => {
  const match = markdown.match(FRONTMATTER_REGEX)
  if (!match) return { content: markdown }
  const frontmatterText = match[1] || ""
  const content = markdown.slice(match[0].length)
  try {
    const data = parseYaml(frontmatterText)
    return {
      name: typeof data.name === "string" ? data.name : undefined,
      description: typeof data.description === "string" ? data.description : undefined,
      type: parseMemoryType(data.type),
      content,
    }
  } catch {
    return { content: markdown }
  }
}
