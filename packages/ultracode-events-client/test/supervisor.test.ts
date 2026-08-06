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

function fixtureSpawn(mode?: string): { spawnCommand: string[]; recordPath: string } {
  const journalDir = mkdtempSync(path.join(tmpdir(), "sc-"))
  const recordPath = path.join(mkdtempSync(path.join(tmpdir(), "sc-rec-")), "commands.tsv")
  const args = [process.execPath, "run", fixturePath, journalDir, recordPath]
  if (mode) args.push(mode)
  return { spawnCommand: args, recordPath }
}

async function countRecords(recordPath: string, method: string): Promise<number> {
  const text = await Bun.file(recordPath).text().catch(() => "")
  return text.split("\n").filter((line) => line.startsWith(method + "\t")).length
}

describe("startSupervised", () => {
  test("handshake resolves and health is ok", async () => {
    const client = await startSupervised({
      journalDir: mkdtempSync(path.join(tmpdir(), "sc-")),
      spawnCommand: fixtureSpawn().spawnCommand,
    })
    expect(client.health()).toBe("ok")
    await client.dispose()
  })

  test("crash during command → supervised restart, queued command completes once", async () => {
    const client = await startSupervised({
      journalDir: mkdtempSync(path.join(tmpdir(), "sc-")),
      spawnCommand: fixtureSpawn().spawnCommand,
    })
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
      spawnCommand: fixtureSpawn().spawnCommand,
    })
    ;(client as any).debug.killForTest()
    await waitFor(async () => client.health() !== "ok")
    const a = client.proposeCommit("k1", {} as any)
    const b = client.proposeCommit("k2", {} as any)
    await expect(client.proposeCommit("k3", {} as any)).rejects.toThrow(/SidecarBufferOverflowError|buffer/)
    await client.dispose()
    await Promise.allSettled([a, b])
  })

  test("healthy burst beyond bufferLimit never overflows and all calls resolve", async () => {
    const { spawnCommand, recordPath } = fixtureSpawn()
    const client = await startSupervised({
      journalDir: mkdtempSync(path.join(tmpdir(), "sc-")),
      bufferLimit: 2,
      spawnCommand,
    })
    expect(client.health()).toBe("ok")
    const pings = Array.from({ length: 7 }, () => client.ping())
    await expect(Promise.all(pings)).resolves.toBeTruthy()
    await waitFor(async () => (await countRecords(recordPath, "ping")) >= 8)
    await client.dispose()
  })

  test("queued command survives a death during flush and completes after the next restart", async () => {
    const { spawnCommand } = fixtureSpawn("die-on-first-commit")
    const client = await startSupervised({ journalDir: mkdtempSync(path.join(tmpdir(), "sc-")), spawnCommand })
    ;(client as any).debug.killForTest()
    await waitFor(async () => client.health() !== "ok")
    const pending = client.proposeCommit("key-1", { kind: "noop" } as any)
    await expect(pending).resolves.toBeTruthy()
    expect(client.restartCount()).toBe(2)
    await client.dispose()
  })

  test("command issued in the death window after killForTest is re-queued and completes", async () => {
    const { spawnCommand, recordPath } = fixtureSpawn("die-on-first-commit")
    const client = await startSupervised({ journalDir: mkdtempSync(path.join(tmpdir(), "sc-")), spawnCommand })
    ;(client as any).debug.killForTest()
    const pending = client.proposeCommit("key-window", { kind: "noop" } as any)
    await waitFor(async () => (await countRecords(recordPath, "propose_commit")) >= 2)
    await expect(pending).resolves.toBeTruthy()
    await client.dispose()
  })
})
