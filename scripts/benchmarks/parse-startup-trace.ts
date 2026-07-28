#!/usr/bin/env bun
// Parses OPENCODE_STARTUP_TRACE JSONL files into a startup baseline JSON.
// Usage: bun run scripts/benchmarks/parse-startup-trace.ts --out <baseline.json> [--mode preview|dev] <trace1.jsonl> [trace2.jsonl ...]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const args = process.argv.slice(2)
const outFlag = args.indexOf("--out")
const modeFlag = args.indexOf("--mode")
if (outFlag === -1 || !args[outFlag + 1]) {
  console.error("usage: parse-startup-trace.ts --out <baseline.json> [--mode preview|dev] <trace...jsonl>")
  process.exit(2)
}
const out = args[outFlag + 1]
const mode = modeFlag !== -1 ? args[modeFlag + 1] : "unknown"
const files = args.filter((arg, index) => arg !== "--out" && arg !== "--mode" && index !== outFlag + 1 && index !== modeFlag + 1)
if (files.length === 0) {
  console.error("no trace files provided")
  process.exit(2)
}

type Row = { name: string; t: number }
const order = ["process_start", "app_ready", "sidecar_connect_start", "credentials_ready", "wsl_init_start", "runtime_ready", "windows_restored", "menu_created"]
const deltas = new Map<string, number[]>()

for (const file of files) {
  const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row)
  const start = rows.find((row) => row.name === "process_start")?.t
  if (start === undefined) {
    console.error(`${file}: missing process_start mark, skipped`)
    continue
  }
  for (const row of rows) {
    const list = deltas.get(row.name) ?? []
    list.push(row.t - start)
    deltas.set(row.name, list)
  }
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

const summary: Record<string, { runs: number; p50: number; p95: number; max: number }> = {}
for (const name of order) {
  const values = deltas.get(name)
  if (!values?.length) continue
  const sorted = [...values].sort((a, b) => a - b)
  summary[name] = { runs: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted[sorted.length - 1] }
}

const baseline = { captured_at: new Date().toISOString(), mode, reference_machine: "see environment.json", files, summary }
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(baseline, null, 2) + "\n")
for (const [name, row] of Object.entries(summary)) {
  console.log(`${name}: p50=${row.p50}ms p95=${row.p95}ms max=${row.max}ms (runs=${row.runs})`)
}
console.log(`wrote ${out}`)
