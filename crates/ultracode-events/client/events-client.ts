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

  private async call(method: string, params: unknown): Promise<any> {
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
        return response.result
      }
      const chunk = await this.reader.read()
      if (chunk.done) throw new Error("sidecar closed stdout")
      this.buffer += decoder.decode(chunk.value, { stream: true })
    }
  }

  async ping(): Promise<{ ok: boolean }> {
    return this.call("ping", {})
  }

  async proposeCommit(key: string, kind: unknown): Promise<ProposeResult> {
    return this.call("propose_commit", { key, kind })
  }

  async listEvents(session: string, sinceSeq = 0, limit = 100): Promise<IndexedEvent[]> {
    return this.call("list_events", { session, since_seq: sinceSeq, limit })
  }

  async rebuildProjections(session: string): Promise<{ count: number }> {
    return this.call("rebuild_projections", { session })
  }

  async putArtifact(bytes: Uint8Array, mime: string, ownerScope: string, retention = "workspace", credentialClass = "plain"): Promise<ArtifactRef> {
    return this.call("put_artifact", {
      bytes_hex: hexEncode(bytes),
      mime,
      owner_scope: ownerScope,
      retention,
      credential_class: credentialClass,
    })
  }

  async openRange(artifactId: string, scope: string, start = 0, end = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
    const result = await this.call("open_range", { artifact_id: artifactId, scope, start, end })
    return hexDecode(result.bytes_hex)
  }

  async reconcileEffects(uncleanStop = true): Promise<EffectReconciliation[]> {
    return this.call("reconcile_effects", { unclean_stop: uncleanStop })
  }

  stop(): void {
    this.proc.kill()
  }
}
