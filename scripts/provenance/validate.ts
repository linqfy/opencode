#!/usr/bin/env bun
// Validates docs/provenance/sources.json and docs/provenance/ledger.json.
// Usage (from repository root): bun run scripts/provenance/validate.ts
// Exit 0 = OK (warnings allowed), Exit 1 = at least one error.
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

type Source = {
  id: string
  repo_path: string
  remote_url: string | null
  branch: string
  pinned_commit: string
  license_spdx: string | null
  license_file: string | null
  notice_file: string | null
  authorization_ref: string | null
  history_available?: boolean
  pinned_commit_observed_at?: string | null
}

type LedgerImport = {
  id: string
  source_id: string
  original_path: string
  destination: string
  treatment: "copy" | "port" | "reimplement"
  owner: string
  imported_from_commit: string
  license_spdx: string
  notice_required: boolean
  authorization_ref: string | null
  imported_at: string
  local_modifications: string[]
  upstream_merge_owner: string
}

const root = process.cwd()
const errors: string[] = []
const warnings: string[] = []

function readJson<T>(rel: string): T | undefined {
  const p = join(root, rel)
  if (!existsSync(p)) {
    errors.push(`missing file: ${rel}`)
    return undefined
  }
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T
  } catch (e) {
    errors.push(`invalid JSON in ${rel}: ${(e as Error).message}`)
    return undefined
  }
}

const COMMIT = /^[0-9a-f]{40}$/
const sources = readJson<Source[]>("docs/provenance/sources.json")
const ledger = readJson<{ version: number; imports: LedgerImport[] }>("docs/provenance/ledger.json")

if (Array.isArray(sources)) {
  const ids = new Set<string>()
  for (const s of sources) {
    if (!s.id) errors.push("source entry missing id")
    if (ids.has(s.id)) errors.push(`duplicate source id: ${s.id}`)
    ids.add(s.id)
    if (!COMMIT.test(s.pinned_commit ?? "")) errors.push(`${s.id}: pinned_commit must be a 40-char lowercase sha`)
    if (s.repo_path && !existsSync(resolve(root, s.repo_path))) errors.push(`${s.id}: no directory at ${s.repo_path}`)
    if (s.history_available === false) {
      warnings.push(`${s.id}: snapshot source without git history — pinned_commit was recorded as observed on ${s.pinned_commit_observed_at ?? "unknown date"} and cannot be re-verified`)
    } else if (s.repo_path && !existsSync(join(resolve(root, s.repo_path), ".git"))) {
      errors.push(`${s.id}: no git repo at ${s.repo_path}`)
    }
    if (s.license_file && !existsSync(join(resolve(root, s.repo_path), s.license_file))) errors.push(`${s.id}: license file ${s.license_file} not found`)
    if (s.notice_file && !existsSync(join(resolve(root, s.repo_path), s.notice_file))) errors.push(`${s.id}: notice file ${s.notice_file} not found`)
    if (!s.license_spdx && !s.authorization_ref) warnings.push(`${s.id}: no license and no authorization_ref — imports from this source are blocked until written authorization is recorded`)
    if (s.authorization_ref && !existsSync(join(root, "docs/provenance", s.authorization_ref))) errors.push(`${s.id}: authorization file docs/provenance/${s.authorization_ref} not found`)
  }
}

if (ledger && Array.isArray(ledger.imports)) {
  if (ledger.version !== 1) errors.push(`ledger.json: unknown version ${ledger.version}`)
  const srcIds = new Set((sources ?? []).map((s) => s.id))
  const dests = new Set<string>()
  for (const imp of ledger.imports) {
    if (!imp.id) errors.push("ledger import missing id")
    if (!srcIds.has(imp.source_id)) errors.push(`${imp.id}: unknown source_id ${imp.source_id}`)
    if (!["copy", "port", "reimplement"].includes(imp.treatment)) errors.push(`${imp.id}: treatment must be copy, port, or reimplement`)
    if (!COMMIT.test(imp.imported_from_commit ?? "")) errors.push(`${imp.id}: imported_from_commit must be a 40-char lowercase sha`)
    if (dests.has(imp.destination)) errors.push(`${imp.id}: duplicate destination ${imp.destination}`)
    dests.add(imp.destination)
    if (!imp.owner) errors.push(`${imp.id}: owner required`)
    if (!imp.upstream_merge_owner) errors.push(`${imp.id}: upstream_merge_owner required`)
    const src = (sources ?? []).find((s) => s.id === imp.source_id)
    if (src && !src.license_spdx) {
      const ref = imp.authorization_ref ?? src.authorization_ref
      if (!ref) {
        errors.push(`${imp.id}: source ${src.id} has no license — entry requires authorization_ref`)
      } else if (!existsSync(join(root, "docs/provenance", ref))) {
        errors.push(`${imp.id}: authorization file docs/provenance/${ref} not found`)
      }
    }
  }
}

for (const w of warnings) console.log(`WARN: ${w}`)
for (const e of errors) console.log(`ERROR: ${e}`)
const srcCount = Array.isArray(sources) ? sources.length : 0
const impCount = ledger?.imports?.length ?? 0
if (errors.length > 0) {
  console.log(`PROVENANCE FAIL: errors=${errors.length} warnings=${warnings.length} sources=${srcCount} imports=${impCount}`)
  process.exit(1)
}
console.log(`PROVENANCE OK: sources=${srcCount} imports=${impCount} warnings=${warnings.length}`)
