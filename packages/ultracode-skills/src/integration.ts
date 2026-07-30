// Integration layer: adapt OpenCode V2 Skill.Info + Source into the unified
// model, apply unified resolution (precedence + conflict detection), and map
// survivors back to V2 Skill.Info. Pure — no OpenCode core imports; operates
// on plain data shapes matching the V2 Skill.Info contract.

import { contentHash, estimateTokens, resolveSkills, type Skill, type SkillSource } from "./index"

// Plain shape matching OpenCode V2 Skill.Info (name, description?, slash?,
// location, content). Kept structural so this module stays core-independent.
export interface SkillInfo {
  readonly name: string
  readonly description?: string
  readonly slash?: boolean
  readonly location: string
  readonly content: string
}

// A V2 Source has a `type` ("directory" | "url" | "embedded"). Map it to a
// unified SkillSource for precedence resolution.
export const mapSourceToSkillSource = (source: { readonly type: string }): SkillSource => {
  switch (source.type) {
    case "embedded":
      return "bundled"
    case "url":
      return "user"
    case "directory":
      return "directory"
    default:
      return "directory"
  }
}

export interface ResolvableSkill<T extends SkillInfo = SkillInfo> {
  readonly info: T
  readonly source: SkillSource
}

const toUnified = ({ info, source }: ResolvableSkill): Skill => ({
  name: info.name,
  source,
  description: info.description,
  content: info.content,
  contentHash: contentHash(info.content),
  location: info.location,
  tokens: estimateTokens(info.content),
  trust: "untrusted",
})

// Apply unified resolution to V2 skills and map survivors back to SkillInfo,
// preserving the original SkillInfo (description/location/slash) for each
// survivor. For identical content at the same precedence level (which dedups),
// the LAST registered source's metadata wins — matching OpenCode V2's
// last-write-wins behavior. Match by name + content hash, taking the last match.
export const resolveSkillInfos = <T extends SkillInfo>(skills: readonly ResolvableSkill<T>[]): T[] => {
  const unified = skills.map(toUnified)
  const resolved = resolveSkills(unified)
  return resolved.map((skill) => {
    const original = [...skills].reverse().find(
      ({ info }) => info.name === skill.name && contentHash(info.content) === skill.contentHash,
    )
    if (!original) throw new Error(`Resolved skill ${skill.name} has no original SkillInfo`)
    return original.info
  })
}
