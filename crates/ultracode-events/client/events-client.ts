// Bun client for the ultracode-events sidecar (newline-delimited JSON-RPC).
// Spawns the sidecar and exposes typed method calls. The sidecar is the sole
// journal writer; this client never touches the journal files directly.

import { spawn, type Subprocess } from "bun"

export type EventServiceConfig = {
  sidecarBin: string
  journalDir: string
  db: string
  artifacts: string
  session: string
}

export type ProposeResult = { seq: number; hash: string; duplicate: boolean }
export type IndexedEvent = { seq: number; id: string; kind: string; session: string; ts: number }
export type ArtifactRef = { artifact_id: string; mime: string; byte_length: number; hash: string }
export type EffectReconciliation = { idempotency_key: string; tool: string; state: string; action: string }
export type MemoryRecord = {
  thread_id: string
  source_session: string
  source_turn: number
  source_end_seq: number
  transcript_artifact_id: string
  extractor_version: string
  source_updated_at: number
  raw_memory: string
  rollout_summary: string
  rollout_slug: string | null
  cwd: string
  git_branch: string | null
  generated_at: number
  usage_count: number
  last_usage: number | null
}
export type MemoryJob = { request_id: string; kind: string; data: unknown }
export type MemoryConsolidation = {
  memory_id: string
  summary: string
  memory: string
  source_thread_ids: string[]
  generated_at: number
}
export type TaskRecord = {
  root_id: string
  task_id: string
  parent_task_id: string | null
  depth: number
  state_changing: boolean
  budget: number
  reserved_parent: number
  reserved_child_pool: number
  reserved_synthesis: number
  budget_used: number
  state: string
  dependencies: string[]
}
export type MailboxMessage = {
  root_id: string
  message_id: string
  sender_task_id: string
  recipient_task_id: string
  sequence: number
  artifact_ids: string[]
  acknowledged: boolean
}
export type TaskDeliverable = {
  root_id: string
  task_id: string
  status: string
  summary: string
  artifact_ids: string[]
  changed_paths: string[]
  test_summary: string | null
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function hexDecode(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export class EventsClient {
  private proc: Subprocess
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private buffer = ""
  private nextId = 1
  private pending = Promise.resolve()

  private constructor(proc: Subprocess) {
    this.proc = proc
    this.reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  }

  static start(config: EventServiceConfig): EventsClient {
    const proc = spawn([
      config.sidecarBin,
      "--journal-dir",
      config.journalDir,
      "--db",
      config.db,
      "--artifacts",
      config.artifacts,
      "--session",
      config.session,
    ], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    return new EventsClient(proc)
  }

  private async call<Result>(method: string, params: unknown): Promise<Result> {
    const result = this.pending.then(() => this.callDirect<Result>(method, params))
    this.pending = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async callDirect<Result>(method: string, params: unknown): Promise<Result> {
    const id = this.nextId++
    const line = JSON.stringify({ id, method, params }) + "\n"
    this.proc.stdin.write(line)

    const decoder = new TextDecoder()
    while (true) {
      const newline = this.buffer.indexOf("\n")
      if (newline !== -1) {
        const raw = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (raw.trim() === "") continue
        const response = JSON.parse(raw)
        if (response.error) throw new Error(response.error)
        return response.result as Result
      }
      const chunk = await this.reader.read()
      if (chunk.done) throw new Error("sidecar closed stdout")
      this.buffer += decoder.decode(chunk.value, { stream: true })
    }
  }

  async ping(): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>("ping", {})
  }

  async proposeCommit(key: string, kind: unknown): Promise<ProposeResult> {
    return this.call<ProposeResult>("propose_commit", { key, kind })
  }

  async listEvents(session: string, sinceSeq = 0, limit = 100): Promise<IndexedEvent[]> {
    return this.call<IndexedEvent[]>("list_events", { session, since_seq: sinceSeq, limit })
  }

  async rebuildProjections(session: string): Promise<{ count: number }> {
    return this.call<{ count: number }>("rebuild_projections", { session })
  }

  async listTasks(rootId: string, limit = 100): Promise<TaskRecord[]> {
    return this.call<TaskRecord[]>("list_tasks", { root_id: rootId, limit })
  }

  async listMailbox(rootId: string, recipientTaskId?: string, afterSequence = 0, limit = 100): Promise<MailboxMessage[]> {
    return this.call<MailboxMessage[]>("list_mailbox", {
      root_id: rootId,
      ...(recipientTaskId === undefined ? {} : { recipient_task_id: recipientTaskId }),
      after_sequence: afterSequence,
      limit,
    })
  }

  async listTaskDeliverables(rootId: string, limit = 100): Promise<TaskDeliverable[]> {
    return this.call<TaskDeliverable[]>("list_task_deliverables", { root_id: rootId, limit })
  }

  async listMemoryRecords(limit = 200): Promise<MemoryRecord[]> {
    return this.call<MemoryRecord[]>("list_memory_records", { limit })
  }

  async listMemoryConsolidations(limit = 200): Promise<MemoryConsolidation[]> {
    return this.call<MemoryConsolidation[]>("list_memory_consolidations", { limit })
  }

  async claimMemoryJob(): Promise<MemoryJob | null> {
    return this.call<MemoryJob | null>("claim_memory_job", {})
  }

  async putArtifact(bytes: Uint8Array, mime: string, ownerScope: string, retention = "workspace", credentialClass = "plain"): Promise<ArtifactRef> {
    return this.call<ArtifactRef>("put_artifact", {
      bytes_hex: hexEncode(bytes),
      mime,
      owner_scope: ownerScope,
      retention,
      credential_class: credentialClass,
    })
  }

  async openRange(artifactId: string, scope: string, start = 0, end = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
    const result = await this.call<{ bytes_hex: string }>("open_range", { artifact_id: artifactId, scope, start, end })
    return hexDecode(result.bytes_hex)
  }

  async reconcileEffects(uncleanStop = true): Promise<EffectReconciliation[]> {
    return this.call<EffectReconciliation[]>("reconcile_effects", { unclean_stop: uncleanStop })
  }

  stop(): void {
    this.proc.kill()
  }
}
