export * as CompactionCheckpointStore from "./compaction-checkpoint-store"

import { createHash } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionSchema } from "./schema"
import type { Planner } from "@ultracode/context"
import type { LLMRequest } from "@opencode-ai/llm"

export interface CompactionCheckpointStoreInput {
  readonly sessionID: SessionSchema.ID
  readonly checkpoint: Planner.CompactionCheckpoint
  readonly contextEpoch: number
  readonly parentCompactionSha?: string
}

export interface Interface {
  readonly put: (input: CompactionCheckpointStoreInput) => Effect.Effect<{ readonly sha: string }, unknown>
  readonly putSnapshot: (request: LLMRequest) => Effect.Effect<{ readonly sha: string }, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/CompactionCheckpointStore") {}

// The canonical artifact body. The in-memory store and the sidecar-backed store
// both serialize through this so the content hash (the sha) is identical for
// the same checkpoint regardless of which store backs the location.
export const canonicalJson = (input: CompactionCheckpointStoreInput): string =>
  JSON.stringify({
    checkpoint: input.checkpoint,
    context_epoch: input.contextEpoch,
    session_id: input.sessionID,
    ...(input.parentCompactionSha === undefined ? {} : { parent_compaction_sha: input.parentCompactionSha }),
  })

// The canonical pre-compaction snapshot body: the full unmutated
// provider-request context captured before any compaction stage mutation runs.
// The body intentionally stays exactly { system, messages, tools } so the
// stored artifact is content-addressed by the context itself.
export const snapshotCanonicalJson = (request: LLMRequest): string =>
  JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools })

export class InMemoryCompactionCheckpointStore implements Interface {
  private readonly records = new Map<string, string>()
  private readonly snapshots = new Map<string, string>()

  put(input: CompactionCheckpointStoreInput): Effect.Effect<{ readonly sha: string }> {
    return Effect.sync(() => {
      const canonical = canonicalJson(input)
      const sha = createHash("sha256").update(canonical).digest("hex")
      this.records.set(sha, canonical)
      return { sha }
    })
  }

  putSnapshot(request: LLMRequest): Effect.Effect<{ readonly sha: string }> {
    return Effect.sync(() => {
      const canonical = snapshotCanonicalJson(request)
      const sha = createHash("sha256").update(canonical).digest("hex")
      this.snapshots.set(sha, canonical)
      return { sha }
    })
  }

  // Test accessor mirroring the sidecar's content addressing: reads back the
  // canonical body for a stored sha.
  retrieve(sha: string): string | undefined {
    return this.records.get(sha)
  }

  retrieveSnapshot(sha: string): string | undefined {
    return this.snapshots.get(sha)
  }

  get snapshotCount(): number {
    return this.snapshots.size
  }
}

const defaultLayer = Layer.succeed(Service, Service.of(new InMemoryCompactionCheckpointStore()))

export const node = makeLocationNode({ service: Service, layer: defaultLayer, deps: [] })
