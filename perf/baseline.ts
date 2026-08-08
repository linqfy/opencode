#!/usr/bin/env bun
// Record-only performance baseline harness. Run from the repository root:
//   bun run perf/baseline.ts
// Measures cold-process startup, session-open TTFT on a recorded cassette,
// idle RSS after sessions, and sidecar spawn latency, then writes
// perf/baselines.json. No machine-dependent thresholds are asserted anywhere.
process.env.OPENCODE_DB = ":memory:"

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"

const RUNS = Number(process.env.BASELINE_RUNS ?? "3")

const LISTENING_MARKER = "opencode server listening on http://"
const STARTUP_TIMEOUT_MS = 60_000

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

const percentile = (values: readonly number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!
}

const summarize = (values: readonly number[]) => ({ runs: values.length, p50: median(values), p95: percentile(values, 95) })

async function measureStartup(): Promise<number[]> {
  const samples: number[] = []
  for (let run = 0; run < RUNS; run++) {
    const started = Date.now()
    const child = spawn(
      "bun",
      ["--cwd", "packages/opencode", "--conditions=browser", "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"],
      { stdio: ["ignore", "pipe", "inherit"] },
    )
    await waitForListening(child, LISTENING_MARKER, STARTUP_TIMEOUT_MS)
    samples.push(Date.now() - started)
    child.kill("SIGTERM")
    if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()))
  }
  return samples
}

const measureTTFT = async (): Promise<number[]> =>
  (await import("../packages/core/test/perf/runner")).measureTTFT(RUNS)

const measureIdleMemory = async (): Promise<number[]> =>
  (await import("../packages/core/test/perf/runner")).measureIdleMemory(RUNS)

async function measureSidecarSpawn(): Promise<number[]> {
  const sidecarBin = resolveSidecarBin()
  if (sidecarBin === undefined) {
    console.error("sidecar binary not found; run `cargo build -p ultracode-events` (debug) first")
    process.exit(2)
  }
  const { EventsClient } = await import("../packages/ultracode-events-client/src/index")
  const samples: number[] = []
  for (let run = 0; run < RUNS; run++) {
    const tmp = mkdtempSync(path.join(tmpdir(), "baseline-sidecar-"))
    const started = Date.now()
    const client = EventsClient.start({
      journalDir: path.join(tmp, "journal"),
      db: path.join(tmp, "events.db"),
      artifacts: path.join(tmp, "artifacts"),
      sidecarBin,
      session: "baseline",
    })
    await client.ping()
    samples.push(Date.now() - started)
    client.stop()
  }
  return samples
}

function waitForListening(child: ChildProcess, marker: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! })
    const timer = setTimeout(() => {
      reject(new Error(`startup timed out waiting for "${marker}"`))
      child.kill("SIGTERM")
    }, timeoutMs)
    lines.on("line", (line) => {
      if (line.includes(marker)) {
        clearTimeout(timer)
        lines.close()
        resolve()
      }
    })
    child.once("error", reject)
  })
}

function resolveSidecarBin(): string | undefined {
  const candidates = [
    process.env.ULTRACODE_EVENTS_SIDECAR_BIN,
    path.resolve("packages/opencode/target/debug", process.platform === "win32" ? "sidecar.exe" : "sidecar"),
    path.resolve("target/debug", process.platform === "win32" ? "sidecar.exe" : "sidecar"),
  ].filter((value): value is string => value !== undefined && existsSync(value))
  return candidates[0]
}

const startup = summarize(await measureStartup())
const ttft = summarize(await measureTTFT())
const idle = summarize(await measureIdleMemory())
const sidecar = summarize(await measureSidecarSpawn())

const baselines = {
  captured_at: new Date().toISOString(),
  reference_machine: "docs/benchmarks/environment.json",
  startup_ms: startup,
  session_open_ttft_ms: ttft,
  idle_memory_after_sessions_mb: idle,
  sidecar_spawn_ms: sidecar,
}

mkdirSync(path.resolve("perf"), { recursive: true })
const target = path.resolve("perf/baselines.json")
writeFileSync(target, JSON.stringify(baselines, null, 2) + "\n")

const metrics = [
  ["startup_ms", startup],
  ["session_open_ttft_ms", ttft],
  ["idle_memory_after_sessions_mb", idle],
  ["sidecar_spawn_ms", sidecar],
] as const
console.log(`${"metric".padEnd(34)}${"runs".padStart(6)}${"p50".padStart(10)}${"p95".padStart(10)}`)
for (const [name, value] of metrics) {
  console.log(
    `${name.padEnd(34)}${String(value.runs).padStart(6)}${value.p50.toFixed(2).padStart(10)}${value.p95.toFixed(2).padStart(10)}`,
  )
}
console.log(`wrote ${target}`)
