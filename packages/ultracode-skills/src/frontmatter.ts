// Frontmatter parser ported from Claude Code's portable frontmatterParser
// (treatment = port). Splits YAML frontmatter from the markdown body and parses
// it. Uses Bun's builtin YAML parser; dependency-free.

export type FrontmatterData = {
  name?: string
  description?: string
  "allowed-tools"?: string | string[]
  "argument-hint"?: string
  when_to_use?: string
  version?: string
  model?: string
  "user-invocable"?: string
  effort?: string
  context?: "inline" | "fork"
  agent?: string
  paths?: string | string[]
  [key: string]: unknown
}

export interface ParsedSkillMarkdown {
  frontmatter: FrontmatterData
  content: string
}

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/

const parseYaml = (text: string): FrontmatterData => {
  const yaml = (Bun as unknown as { YAML?: { parse: (input: string) => unknown } }).YAML
  if (yaml) {
    const parsed = yaml.parse(text)
    return (parsed && typeof parsed === "object" ? parsed : {}) as FrontmatterData
  }
  // Minimal fallback: key: value lines (no nested structures).
  const result: Record<string, unknown> = {}
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (match) result[match[1]] = match[2]
  }
  return result as FrontmatterData
}

export const parseSkillMarkdown = (markdown: string): ParsedSkillMarkdown => {
  const match = markdown.match(FRONTMATTER_REGEX)
  if (!match) return { frontmatter: {}, content: markdown }
  const frontmatterText = match[1] || ""
  const content = markdown.slice(match[0].length)
  try {
    return { frontmatter: parseYaml(frontmatterText), content }
  } catch {
    return { frontmatter: {}, content: markdown }
  }
}
