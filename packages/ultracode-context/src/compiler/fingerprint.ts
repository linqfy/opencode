import { createHash } from "node:crypto"

// Deterministic JSON: object keys sorted recursively, array order preserved.
// Semantically identical inputs produce byte-identical output, so identical
// prompts yield identical fingerprints (spec: byte-identical prefixes).
export const canonicalStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`
  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
  return `{${entries.join(",")}}`
}

export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex")
