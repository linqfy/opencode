import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventsClient } from "./events-client"

// The sidecar binary is built by cargo into target/debug.
const sidecarBin = join(import.meta.dir, "..", "..", "..", "target", "debug", process.platform === "win32" ? "sidecar.exe" : "sidecar")

describe("EventsClient", () => {
  let dir: string
  let client: EventsClient

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ultracode-client-"))
    client = EventsClient.start({
      sidecarBin,
      journalDir: join(dir, "journal"),
      db: join(dir, "proj.db"),
      artifacts: join(dir, "blobs"),
      session: "ses_1",
    })
  })

  afterAll(async () => {
    client.stop()
    // On Windows the killed sidecar's SQLite WAL/journal handles release
    // asynchronously; give them a beat, and never let teardown fail a test
    // whose assertions already passed (the OS temp cleaner reclaims the rest).
    await Bun.sleep(200)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // EBUSY on locked WAL/journal files is benign here.
    }
  })

  test("ping, commit, list, and artifact round trip", async () => {
    expect(await client.ping()).toEqual({ ok: true })

    const committed = await client.proposeCommit("cmd_a", { kind: "turn-started", data: { turn: 1 } })
    expect(committed.seq).toBe(1)
    expect(committed.duplicate).toBe(false)

    const retry = await client.proposeCommit("cmd_a", { kind: "turn-started", data: { turn: 1 } })
    expect(retry.duplicate).toBe(true)

    const events = await client.listEvents("ses_1")
    expect(events.length).toBe(1)
    expect(events[0].kind).toBe("turn-started")

    const reference = await client.putArtifact(new TextEncoder().encode("hello client"), "text/plain", "ses_1")
    const bytes = await client.openRange(reference.artifact_id, "ses_1", 0, 5)
    expect(new TextDecoder().decode(bytes)).toBe("hello")
  })

  test("memory wrappers round trip through the sidecar", async () => {
    await client.proposeCommit("memory-request", {
      kind: "memory-extraction-requested",
      data: {
        request_id: "req-client",
        source_session: "ses_1",
        source_turn: 1,
        source_end_seq: 1,
        transcript_artifact_id: "art-client",
        extractor_version: "v1",
      },
    })
    expect((await client.claimMemoryJob())?.request_id).toBe("req-client")
    expect((await client.failMemoryJob("req-client", "retry")).ok).toBe(true)
    expect((await client.claimMemoryJob())?.request_id).toBe("req-client")
    await client.proposeCommit("memory-result", {
      kind: "memory-extracted",
      data: {
        request_id: "req-client",
        thread_id: "thread-client",
        source_updated_at: 1,
        raw_memory: "raw",
        rollout_summary: "summary",
        rollout_slug: null,
        cwd: "/repo",
        git_branch: null,
        generated_at: 2,
      },
    })
    const records = await client.listMemoryRecords(500)
    expect(records).toHaveLength(1)
    expect(records[0].thread_id).toBe("thread-client")
    expect(await client.claimMemoryJob()).toBeNull()
  })
})
