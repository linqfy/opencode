import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startupMark } from "./startup-trace"

describe("startupMark", () => {
  const dir = mkdtempSync(join(tmpdir(), "startup-trace-"))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("writes JSONL rows with name and millisecond timestamp", () => {
    const file = join(dir, "trace.jsonl")
    startupMark("process_start", file)
    startupMark("app_ready", file)
    const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(rows.length).toBe(2)
    expect(rows[0].name).toBe("process_start")
    expect(rows[1].name).toBe("app_ready")
    expect(typeof rows[0].t).toBe("number")
    expect(rows[1].t).toBeGreaterThanOrEqual(rows[0].t)
  })

  test("creates missing parent directories", () => {
    const file = join(dir, "nested", "deep", "trace.jsonl")
    startupMark("process_start", file)
    expect(readFileSync(file, "utf8")).toContain("process_start")
  })

  test("is a no-op without a trace file", () => {
    expect(() => startupMark("process_start", undefined)).not.toThrow()
  })
})
