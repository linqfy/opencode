import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const BASELINES = path.resolve(import.meta.dir, "../../../../perf/baselines.json")

const METRICS = ["startup_ms", "session_open_ttft_ms", "idle_memory_after_sessions_mb", "sidecar_spawn_ms"] as const

describe("perf/baselines.json schema", () => {
  test("committed baselines carry the four required numeric metrics", () => {
    const baselines = JSON.parse(readFileSync(BASELINES, "utf8")) as Record<string, unknown>
    expect(typeof baselines.captured_at).toBe("string")
    for (const metric of METRICS) {
      const value = baselines[metric]
      // bun 1.3.14 toMatchObject with expect.any(Number) mutates the received
      // object (fields become {}), so snapshot p50 before the shape assertion.
      const p50 = (value as { p50: number }).p50
      expect(value, metric).toMatchObject({ runs: expect.any(Number), p50: expect.any(Number), p95: expect.any(Number) })
      expect(typeof p50).toBe("number")
      expect(p50).toBeGreaterThanOrEqual(0)
    }
  })
})
