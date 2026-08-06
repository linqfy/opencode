import { describe, test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveSidecarBin, SidecarNotFoundError } from "../src/resolve"

function fakeBin(dir: string, name: string) {
  mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  writeFileSync(p, "#!/bin/sh\nexit 0\n")
  chmodSync(p, 0o755)
  return p
}

describe("resolveSidecarBin", () => {
  test("env override wins when it points at an executable file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sidecar-resolve-"))
    const bin = fakeBin(dir, process.platform === "win32" ? "sidecar.exe" : "sidecar")
    const found = await resolveSidecarBin({ env: { ULTRACODE_EVENTS_SIDECAR_BIN: bin } })
    expect(found).toBe(bin)
  })

  test("env override pointing at a missing file is rejected, not silently skipped", async () => {
    await expect(
      resolveSidecarBin({ env: { ULTRACODE_EVENTS_SIDECAR_BIN: "/no/such/path/sidecar" } }),
    ).rejects.toBeInstanceOf(SidecarNotFoundError)
  })

  test("not found anywhere → error names probed paths and the env hint", async () => {
    try {
      await resolveSidecarBin({ env: {} })
      expect.unreachable("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(SidecarNotFoundError)
      expect(String((e as Error).message)).toContain("ULTRACODE_EVENTS_SIDECAR_BIN")
    }
  })
})
