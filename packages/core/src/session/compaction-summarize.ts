import type { CompactionCheckpoint } from "@ultracode/context"

const CHECKPOINT_FIELDS = [
  "objective", "completed", "constraints", "decisions", "workingSet", "facts",
  "toolArtifacts", "tests", "errors", "pending", "approvalState", "agentLineage",
] as const

// Asks the model for the typed checkpoint as JSON (spec section 8 schema).
export const checkpointPrompt = (conversation: readonly string[]): string =>
  [
    "Summarize the conversation below into a JSON checkpoint object. Output ONLY valid JSON, no prose, no code fences.",
    "The JSON must have these fields: objective (string), completed (string[]), constraints (string[]),",
    "decisions ({choice,reason,evidence?}[]), workingSet ({path,symbol?,hash?}[]), facts ({claim,source,confidence,trust}[]),",
    "toolArtifacts (string[]), tests ({command,status,outputRef?}[]), errors (string[]), pending (string[]),",
    "approvalState (string[]), agentLineage (string[]). Keep every field (use [] when empty).",
    "Preserve exact file paths, symbols, commands, error strings, and identifiers.",
    "",
    "<conversation>",
    ...conversation,
    "</conversation>",
  ].join("\n")

const extractJson = (text: string): string => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) return fenced[1].trim()
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first !== -1 && last > first) return text.slice(first, last + 1)
  return text.trim()
}

// Parses a typed checkpoint from model output; undefined if unparseable.
export const parseCheckpoint = (text: string): CompactionCheckpoint | undefined => {
  try {
    const parsed = JSON.parse(extractJson(text))
    if (typeof parsed !== "object" || parsed === null || typeof parsed.objective !== "string") return undefined
    const withDefaults = {
      objective: parsed.objective,
      completed: parsed.completed ?? [],
      constraints: parsed.constraints ?? [],
      decisions: parsed.decisions ?? [],
      workingSet: parsed.workingSet ?? [],
      facts: parsed.facts ?? [],
      toolArtifacts: parsed.toolArtifacts ?? [],
      tests: parsed.tests ?? [],
      errors: parsed.errors ?? [],
      pending: parsed.pending ?? [],
      approvalState: parsed.approvalState ?? [],
      agentLineage: parsed.agentLineage ?? [],
      worldStateBaseline: parsed.worldStateBaseline,
      recentTailStartId: parsed.recentTailStartId,
    }
    void CHECKPOINT_FIELDS
    return withDefaults
  } catch {
    return undefined
  }
}

// A minimal checkpoint used when the model output cannot be parsed: the raw
// summary becomes the objective. Compaction must never fail on a parse error.
export const fallbackCheckpoint = (rawSummary: string): CompactionCheckpoint => ({
  objective: rawSummary,
  completed: [], constraints: [], decisions: [], workingSet: [], facts: [],
  toolArtifacts: [], tests: [], errors: [], pending: [], approvalState: [], agentLineage: [],
})

// Serializes a checkpoint to the summary string carried by Compaction.Ended.
export const serializeCheckpoint = (checkpoint: CompactionCheckpoint): string => {
  const lines: string[] = [`## Objective`, checkpoint.objective]
  const section = (title: string, items: readonly string[]) => {
    if (items.length === 0) return
    lines.push(`## ${title}`, ...items.map((item) => `- ${item}`))
  }
  section("Completed", checkpoint.completed)
  section("Constraints", checkpoint.constraints)
  section("Decisions", checkpoint.decisions.map((d) => `${d.choice} — ${d.reason}`))
  section("Working Set", checkpoint.workingSet.map((w) => w.path))
  section("Facts", checkpoint.facts.map((f) => f.claim))
  section("Pending", checkpoint.pending)
  section("Errors", checkpoint.errors)
  return lines.join("\n")
}
