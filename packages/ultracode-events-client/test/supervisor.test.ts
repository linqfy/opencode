import { describe, test, expect } from "bun:test"
import { startSupervised } from "../src/supervisor"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

async function waitFor(cond: () => Promise<boolean>, ms = 5000, step = 50) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await cond()) return
    await Bun.sleep(step)
  }
  throw new Error("waitFor timed out")
}

const fixturePath = path.join(import.meta.dir, "fixtures", "fake-sidecar.ts")

function fixtureSpawn(): string[] {
  const journalDir = mkdtempSync(path.join(tmpdir(), "sc-"))
  const recordPath = path.join(mkdtempSync(path.join(tmpdir(), "sc-rec-")), "commands.tsv")
  return [process.execPath, "run", fixturePath, journalDir, recordPath]
}

describe("startSupervised", () => {
  test("handshake resolves and health is ok", async () => {
    const client = await startSupervised({ journalDir: mkdtempSync(path.join(tmpdir(), "sc-")), spawnCommand: fixtureSpawn() })
    expect(client.health()).toBe("ok")
    await client.dispose()
  })

  test("crash during command → supervised restart, queued command completes once", async () => {
    const client = await startSupervised({ journalDir: mkdtempSync(path.join(tmpdir(), "sc-")), spawnCommand: fixtureSpawn() })
    ;(client as any).debug.killForTest()
    await waitFor(async () => client.health() !== "ok")
    const pending = client.proposeCommit("key-1", { kind: "noop" } as any)
    await waitFor(async () => client.health() === "ok")
    await expect(pending).resolves.toBeTruthy()
    expect(client.restartCount()).toBe(1)
    await client.dispose()
  })

  test("buffer overflow rejects with SidecarBufferOverflowError", async () => {
    const client = await startSupervised({
      journalDir: mkdtempSync(path.join(tmpdir(), "sc-")),
      bufferLimit: 2,
      spawnCommand: fixtureSpawn(),
    })
    ;(client as any).debug.killForTest()
    await waitFor(async () => client.health() !== "ok")
    const a = client.proposeCommit("k1", {} as any)
    const b = client.proposeCommit("k2", {} as any)
    await expect(client.proposeCommit("k3", {} as any)).rejects.toThrow(/SidecarBufferOverflowError|buffer/)
    await client.dispose()
    await Promise.allSettled([a, b])
  })
})
