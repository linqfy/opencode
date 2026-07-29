// Resolution precedence + safety (spec section 9). Deterministic precedence by
// source rank; same name+level with differing content is an error. Path-safety
// guards prevent traversal and enforce containment (ported from OpenCode V2's
// hardened discovery checks).

import { SOURCE_PRECEDENCE, skillIdentity, type Skill } from "./types"

export const resolveSkills = (skills: readonly Skill[]): Skill[] => {
  const byName = new Map<string, Skill>()
  for (const skill of skills) {
    const existing = byName.get(skill.name)
    if (!existing) {
      byName.set(skill.name, skill)
      continue
    }
    const incomingRank = SOURCE_PRECEDENCE[skill.source]
    const existingRank = SOURCE_PRECEDENCE[existing.source]
    if (incomingRank < existingRank) {
      byName.set(skill.name, skill)
      continue
    }
    if (incomingRank === existingRank) {
      if (skill.contentHash === existing.contentHash) continue // identical -> dedup
      throw new Error(
        `conflicting skills named "${skill.name}" at precedence level "${skill.source}" (${skillIdentity(existing)} vs ${skillIdentity(skill)})`,
      )
    }
    // incomingRank > existingRank: existing wins, ignore incoming.
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
}

// Reject path traversal, absolute paths, backslashes, null bytes, and URL-like
// values (ported from OpenCode V2's isSafeRelativePath).
export const isSafeRelativePath = (value: string): boolean => {
  if (value.length === 0) return false
  if (value.includes("\\") || value.includes("\0")) return false
  if (value.includes("?") || value.includes("#")) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false // URL scheme
  if (value.startsWith("/")) return false
  const segments = value.split("/")
  return segments.every((segment) => {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return false
    }
    return decoded.length > 0 && decoded !== "." && decoded !== ".." && !decoded.includes("/") && !decoded.includes("\\")
  })
}

// True if `child` is contained within `parent` (or equal). Ported from
// OpenCode's FSUtil.contains.
export const containsPath = (parent: string, child: string): boolean => {
  const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")
  const parentNorm = normalize(parent)
  const childNorm = normalize(child)
  if (childNorm === parentNorm) return true
  return childNorm.startsWith(parentNorm + "/")
}
