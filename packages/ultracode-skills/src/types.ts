// Unified skill model (spec section 9). Combines Claude Code's rich skill
// metadata (CommandBase & PromptCommand, trimmed of Claude-only union members
// and singletons), OpenCode V2's source/location model, and UltraCode additions
// (contentHash, dependencies, fully-qualified identity).

export type SkillSource =
  | "managed" // managed/team policy — highest precedence, can lock a name
  | "user" // user-installed
  | "directory" // nearest authorized directory scope
  | "repository" // repository root
  | "plugin" // explicitly selected plugin
  | "mcp" // MCP-provided
  | "bundled" // bundled system skill — lowest precedence

// Precedence rank: lower number = higher precedence.
export const SOURCE_PRECEDENCE: Record<SkillSource, number> = {
  managed: 0,
  user: 1,
  directory: 2,
  repository: 3,
  plugin: 4,
  mcp: 5,
  bundled: 6,
}

export type SkillExecutionContext = "inline" | "fork"

export interface SkillDependency {
  readonly name: string
  readonly version?: string
}

export interface Skill {
  readonly name: string
  readonly source: SkillSource
  readonly description?: string
  readonly content: string
  readonly contentHash: string
  readonly location: string
  readonly tokens: number
  // Fully-qualified identity components.
  readonly namespace?: string
  readonly version?: string
  // Claude-derived rich metadata.
  readonly whenToUse?: string
  readonly allowedTools?: readonly string[]
  readonly requiredTools?: readonly string[]
  readonly model?: string
  readonly effort?: string
  readonly executionContext?: SkillExecutionContext
  readonly agent?: string
  readonly paths?: readonly string[]
  readonly hooks?: unknown
  // Codex-derived provenance/dependencies.
  readonly dependencies?: readonly SkillDependency[]
  readonly provenance?: string
  // Trust: a skill body is untrusted data until an invocation-time permission
  // gate approves it. Loading never confers privilege.
  readonly trust?: "privileged" | "untrusted"
}

// Fully-qualified identity: source-namespace/name@version (namespace and
// version omitted when absent). Prevents cross-source shadowing.
export const skillIdentity = (skill: Skill): string => {
  const qualified = skill.namespace ? `${skill.namespace}/${skill.name}` : skill.name
  const versioned = skill.version ? `${qualified}@${skill.version}` : qualified
  return `${skill.source}:${versioned}`
}

// A skill source to discover from (mirrors OpenCode V2's Source union).
export type SkillSourceSpec =
  | { readonly type: "directory"; readonly path: string; readonly source: SkillSource }
  | { readonly type: "url"; readonly url: string; readonly source: SkillSource }
  | { readonly type: "embedded"; readonly skill: Skill }
