// Skill discovery: build Skill records from SKILL.md content. Pure — filesystem
// access and disable flags are injected (SkillEnv), no singleton imports.
// Mirrors OpenCode V2's source model + Claude's frontmatter-driven metadata.

import { parseSkillMarkdown } from "./frontmatter"
import type { Skill, SkillSource } from "./types"

export const estimateTokens = (text: string): number => Math.max(0, Math.round(text.length / 4))

export const contentHash = (content: string): string =>
  new Bun.CryptoHasher("sha256").update(content).digest("hex")

const coerceStringList = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return value.map(String)
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

// Derive the skill name: frontmatter `name`, else the parent directory name
// (for `<dir>/SKILL.md`), else the file basename (for `<name>.md` at a root).
const deriveName = (frontmatterName: string | undefined, location: string): string | undefined => {
  if (frontmatterName) return frontmatterName
  const normalized = location.replace(/\\/g, "/")
  const base = normalized.split("/").filter(Boolean).pop() ?? ""
  if (base === "SKILL.md") {
    const segments = normalized.split("/").filter(Boolean)
    return segments.length >= 2 ? segments[segments.length - 2] : undefined
  }
  if (base.endsWith(".md")) return base.slice(0, -3)
  return undefined
}

export interface LoadOptions {
  location: string
  source: SkillSource
  namespace?: string
}

export const loadSkillFromMarkdown = (markdown: string, options: LoadOptions): Skill | undefined => {
  const { frontmatter, content } = parseSkillMarkdown(markdown)
  const name = deriveName(frontmatter.name, options.location)
  if (!name) return undefined
  const executionContext = frontmatter.context === "fork" ? "fork" : frontmatter.context === "inline" ? "inline" : undefined
  return {
    name,
    source: options.source,
    namespace: options.namespace,
    version: typeof frontmatter.version === "string" ? frontmatter.version : undefined,
    description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
    whenToUse: typeof frontmatter.when_to_use === "string" ? frontmatter.when_to_use : undefined,
    allowedTools: coerceStringList(frontmatter["allowed-tools"]),
    model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
    effort: typeof frontmatter.effort === "string" ? frontmatter.effort : undefined,
    executionContext,
    agent: typeof frontmatter.agent === "string" ? frontmatter.agent : undefined,
    paths: coerceStringList(frontmatter.paths),
    content,
    contentHash: contentHash(content),
    location: options.location,
    tokens: estimateTokens(content),
    trust: "untrusted",
  }
}
