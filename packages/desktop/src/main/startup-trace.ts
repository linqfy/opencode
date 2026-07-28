import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

// Emits JSONL timing marks when OPENCODE_STARTUP_TRACE points at a trace file.
// Consumed by scripts/benchmarks/parse-startup-trace.ts. No-op when unset;
// tracing must never break startup.
export type StartupMark =
  | "process_start"
  | "app_ready"
  | "sidecar_connect_start"
  | "credentials_ready"
  | "wsl_init_start"
  | "runtime_ready"
  | "windows_restored"
  | "menu_created"

export function startupMark(name: StartupMark, file = process.env.OPENCODE_STARTUP_TRACE) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({ name, t: Date.now() }) + "\n")
  } catch {}
}
