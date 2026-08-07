import { describe, expect, test } from "bun:test"
import { EventsClient } from "../src"
import { spawn } from "bun"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const fixturePath = path.join(import.meta.dir, "fixtures", "fake-sidecar.ts")

function startFakeSidecar(): { client: EventsClient; recordPath: string; dispose: () => void } {
  const recordPath = path.join(mkdtempSync(path.join(tmpdir(), "mj-rec-")), "commands.tsv")
  const journalDir = mkdtempSync(path.join(tmpdir(), "mj-"))
  const proc = spawn([process.execPath, "run", fixturePath, journalDir, recordPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  return { client: EventsClient.attach(proc), recordPath, dispose: () => proc.kill() }
}

async function records(recordPath: string): Promise<string[]> {
  const text = await Bun.file(recordPath).text().catch(() => "")
  return text.split("\n").filter((line) => line.length > 0)
}

const requested = {
  kind: "memory-extraction-requested",
  data: {
    request_id: "req-1",
    source_session: "ses_1",
    source_turn: 1,
    source_end_seq: 10,
    transcript_artifact_id: "art_1",
    extractor_version: "v1",
  },
}

const extracted = {
  kind: "memory-extracted",
  data: {
    request_id: "req-1",
    thread_id: "thread-1",
    source_updated_at: 100,
    raw_memory: "raw-1",
    rollout_summary: "summary",
    rollout_slug: "rollout",
    cwd: "/repo",
    git_branch: "main",
    generated_at: 101,
  },
}

describe("memory job client methods", () => {
  test("enqueueMemoryJob proposes the extraction-requested event under the key", async () => {
    const { client, recordPath, dispose } = startFakeSidecar()
    const result = await client.enqueueMemoryJob("mem:ses_1:1", requested)
    expect(result.duplicate).toBe(false)
    const line = (await records(recordPath)).find((entry) => entry.startsWith("propose_commit\t"))
    expect(line).toBeDefined()
    const params = JSON.parse(line!.split("\t")[2]!)
    expect(params.key).toBe("mem:ses_1:1")
    expect(params.kind).toEqual(requested)
    dispose()
  })

  test("completeMemoryJob proposes the extracted event under the key", async () => {
    const { client, recordPath, dispose } = startFakeSidecar()
    const result = await client.completeMemoryJob("mem:ses_1:1:done", extracted)
    expect(result.duplicate).toBe(false)
    const line = (await records(recordPath)).find((entry) => entry.startsWith("propose_commit\t"))
    expect(line).toBeDefined()
    const params = JSON.parse(line!.split("\t")[2]!)
    expect(params.key).toBe("mem:ses_1:1:done")
    expect(params.kind).toEqual(extracted)
    dispose()
  })

  test("claimMemoryJob round-trips a job over the sidecar", async () => {
    const { client, recordPath, dispose } = startFakeSidecar()
    const job = await client.claimMemoryJob()
    expect(job).toBeTruthy()
    expect((await records(recordPath)).some((entry) => entry.startsWith("claim_memory_job\t"))).toBe(
      true,
    )
    dispose()
  })
})
