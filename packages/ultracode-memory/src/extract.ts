// Phase 1 memory extraction (ported from Codex's memories/write phase1.rs).
// Calls an injected LLM with a strict JSON-schema output, redacts secrets, and
// returns the extraction. Fails closed (undefined) on any error.

export interface MemoryExtraction {
  readonly rawMemory: string
  readonly rolloutSummary: string
  readonly rolloutSlug?: string
}

// Injected LLM extractor seam: given the serialized transcript, return the
// strict JSON output string { raw_memory, rollout_summary, rollout_slug }.
// Replaces Codex's stream_stage_one_prompt (ModelClient call with output_schema).
export type MemoryExtractor = (transcript: string) => Promise<string>

// The strict JSON schema forced on the extraction model (ported from Codex's
// phase1::output_schema).
export const EXTRACTION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    rollout_summary: { type: "string" },
    rollout_slug: { type: ["string", "null"] },
    raw_memory: { type: "string" },
  },
  required: ["rollout_summary", "rollout_slug", "raw_memory"],
  additionalProperties: false,
} as const

// Redact obvious secrets (API keys, tokens) from extracted text. Ported from
// Codex's redact_secrets (a conservative pattern-based redaction).
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:api[_-]?key|token|secret)\b\s*[=:]\s*["']?[A-Za-z0-9_-]{12,}["']?/gi,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
]

export const redactSecrets = (text: string): string =>
  SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[REDACTED]"), text)

const parseExtraction = (raw: string): MemoryExtraction | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const output = parsed as Record<string, unknown>
  const keys = Object.keys(output)
  if (
    keys.length !== 3 ||
    !keys.every((key) => key === "raw_memory" || key === "rollout_summary" || key === "rollout_slug") ||
    typeof output.raw_memory !== "string" ||
    typeof output.rollout_summary !== "string" ||
    (typeof output.rollout_slug !== "string" && output.rollout_slug !== null)
  ) {
    return undefined
  }
  return {
    rawMemory: redactSecrets(output.raw_memory),
    rolloutSummary: redactSecrets(output.rollout_summary),
    rolloutSlug: typeof output.rollout_slug === "string" ? redactSecrets(output.rollout_slug) : undefined,
  }
}

// Run Phase 1 extraction. Fails closed (undefined) on any error or invalid output.
export const extractMemory = async (
  transcript: string,
  extract: MemoryExtractor,
): Promise<MemoryExtraction | undefined> => {
  try {
    return parseExtraction(await extract(transcript))
  } catch {
    return undefined
  }
}
