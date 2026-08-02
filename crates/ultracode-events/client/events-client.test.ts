import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventsClient } from "./events-client"
import { EventsMemoryJobClient } from "./events-memory-client"
import { processMemoryJob } from "../../../packages/ultracode-memory/src/worker"

// The sidecar binary is built by cargo into target/debug.
const sidecarBin = join(import.meta.dir, "..", "..", "..", "target", "debug", process.platform === "win32" ? "sidecar.exe" : "sidecar")

describe("EventsClient", () => {
  let dir: string
  let client: EventsClient

  const startClient = () => EventsClient.start({
    sidecarBin,
    journalDir: join(dir, "journal"),
    db: join(dir, "proj.db"),
    artifacts: join(dir, "blobs"),
    session: "ses_1",
  })

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ultracode-client-"))
    client = startClient()
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

  test("sidecar client exposes durable memory workflows", async () => {
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
    await client.proposeCommit("consolidation-request", {
      kind: "memory-consolidation-requested",
      data: { request_id: "req-consolidation", record_thread_ids: ["thread-client"], consolidator_version: "v1" },
    })
    expect((await client.claimMemoryJob())?.request_id).toBe("req-consolidation")
    await client.proposeCommit("consolidation-result", {
      kind: "memory-consolidated",
      data: {
        request_id: "req-consolidation",
        memory_id: "consolidated-client",
        summary: "summary",
        memory: "memory",
        source_thread_ids: ["thread-client"],
        generated_at: 10,
      },
    })
    await client.rebuildProjections("ses_1")
    client.stop()
    await Bun.sleep(200)
    client = startClient()
    expect(await client.listMemoryConsolidations()).toEqual([
      { memory_id: "consolidated-client", summary: "summary", memory: "memory", source_thread_ids: ["thread-client"], generated_at: 10 },
    ])
    const artifact = await client.putArtifact(new TextEncoder().encode("transcript"), "text/plain", "ses_1")
    await client.proposeCommit("adapter-request", {
      kind: "memory-extraction-requested",
      data: {
        request_id: "req-adapter",
        source_session: "ses_1",
        source_turn: 1,
        source_end_seq: 1,
        transcript_artifact_id: artifact.artifact_id,
        extractor_version: "v1",
      },
    })

    expect(
      await processMemoryJob({
        client: new EventsMemoryJobClient(client),
        extract: async (transcript) => {
          expect(transcript).toBe("transcript")
          return JSON.stringify({ raw_memory: "extracted", rollout_summary: "summary", rollout_slug: null })
        },
        consolidate: async () => "",
        now: () => 20,
      }),
    ).toBe(true)
    expect(await client.listMemoryRecords()).toContainEqual(
      expect.objectContaining({ thread_id: "memory:req-adapter", raw_memory: "extracted" }),
    )
  })

  test("sidecar client exposes root-scoped task queries", async () => {
    await client.proposeCommit("task-root", {
      kind: "task-spawned",
      data: {
        root_id: "root-client",
        task_id: "task-client",
        parent_task_id: null,
        depth: 0,
        state_changing: true,
        dependencies: [],
        budget: 10,
        workspace_directory: "C:\\workspace",
      },
    })
    await client.proposeCommit("task-child", {
      kind: "task-spawned",
      data: { root_id: "root-client", task_id: "task-child", parent_task_id: "task-client", depth: 1, state_changing: true, dependencies: [], budget: 5 },
    })
    await client.proposeCommit("task-running", {
      kind: "task-state-changed", data: { root_id: "root-client", task_id: "task-client", state: "running", reason: null },
    })
    await client.proposeCommit("task-completed", {
      kind: "task-state-changed", data: { root_id: "root-client", task_id: "task-client", state: "completed", reason: null },
    })
    await client.proposeCommit("task-message", {
      kind: "mailbox-message-sent", data: {
        root_id: "root-client", message_id: "message-client", sender_task_id: "task-client", recipient_task_id: "task-child", sequence: 1,
        summary: "child completed the task", artifact_ids: ["art-client"], changed_paths: ["src/task.ts"], test_summary: "bun test", blocked_reason: null,
      },
    })
    await client.proposeCommit("task-deliverable", {
      kind: "task-deliverable-committed", data: { root_id: "root-client", task_id: "task-client", status: "completed", summary: "done", artifact_ids: [], changed_paths: [], test_summary: null },
    })

    expect(await client.listTasks("root-client", "C:\\workspace")).toHaveLength(2)
    expect(await client.listMailbox("root-client", "C:\\workspace", "task-child")).toEqual([
      expect.objectContaining({
        summary: "child completed the task",
        artifact_ids: ["art-client"],
        changed_paths: ["src/task.ts"],
        test_summary: "bun test",
        blocked_reason: null,
      }),
    ])
    expect(await client.listTaskDeliverables("root-client", "C:\\workspace")).toHaveLength(1)
  })

  test("sidecar client exposes paged Stage 7 reads", async () => {
    const page = await client.queryTaskGraph("root-client", "C:\\workspace", undefined, 1)
    expect(page).toEqual(expect.objectContaining({ tasks: expect.any(Array), edges: expect.any(Array) }))
    const deliverables = await client.queryTaskDeliverables("root-client", "C:\\workspace", undefined, 1)
    expect(deliverables).toEqual(expect.objectContaining({ items: expect.any(Array), next_cursor: null }))
  })
})
