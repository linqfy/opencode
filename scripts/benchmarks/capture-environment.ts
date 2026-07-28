#!/usr/bin/env bun
// Captures environment facts for benchmark baselines.
// Usage (from repository root): bun run scripts/benchmarks/capture-environment.ts
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { arch, cpus, platform, release, totalmem } from "node:os"

async function cmd(c: string[]): Promise<string> {
  try {
    const p = Bun.spawn(c, { stdout: "pipe", stderr: "ignore" })
    const code = await p.exited
    if (code !== 0) return "unavailable"
    return (await new Response(p.stdout).text()).trim()
  } catch {
    return "unavailable"
  }
}

const data = {
  captured_at: new Date().toISOString(),
  os: { platform: platform(), release: release(), arch: arch() },
  cpu_model: cpus()[0]?.model ?? "unknown",
  logical_cores: cpus().length,
  total_memory_gib: Math.round((totalmem() / 2 ** 30) * 10) / 10,
  git: await cmd(["git", "--version"]),
  bun: await cmd(["bun", "--version"]),
  rustc: await cmd(["rustc", "--version"]),
  opencode_head: await cmd(["git", "-C", "../opencode", "rev-parse", "HEAD"]),
  ultracode_head: await cmd(["git", "rev-parse", "HEAD"]),
}

mkdirSync(join(process.cwd(), "docs/benchmarks"), { recursive: true })
const target = join(process.cwd(), "docs", "benchmarks", "environment.json")
writeFileSync(target, JSON.stringify(data, null, 2) + "\n")
console.log(`wrote ${target}`)
