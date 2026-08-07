import { Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { Location } from "@opencode-ai/core/location"
import { CompactionCheckpointStore } from "@opencode-ai/core/session/compaction-checkpoint-store"
import { SchedulerService } from "@/agent/scheduler-service"

// Backs the location-scoped CompactionCheckpointStore with the sidecar's
// content-addressed artifact store. The owner scope is the workspace directory
// and the retention class honors the session-scoped audit intent; the nearest
// supported class is "session".
const sidecarLayer = Layer.effect(
  CompactionCheckpointStore.Service,
  Effect.gen(function* () {
    const scheduler = yield* SchedulerService.Service
    const location = yield* Location.Service
    return CompactionCheckpointStore.Service.of({
      put: (input) => {
        const bytes = new TextEncoder().encode(CompactionCheckpointStore.canonicalJson(input))
        // Resolve the write API lazily so an unavailable scheduler degrades to
        // checkpointLost per put instead of failing the whole location graph.
        return scheduler.artifactWrite.pipe(
          Effect.flatMap((write) =>
            Effect.tryPromise({
              try: () => write.putArtifact(bytes, "application/json", location.directory, "session"),
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
            }),
          ),
          Effect.map((ref) => ({ sha: ref.hash })),
        )
      },
    })
  }),
)

// Replaces the in-memory CompactionCheckpointStore in the location service
// graph so compaction checkpoints persist to the sidecar's artifact store.
export const sidecarCheckpointStoreNode = makeLocationNode({
  service: CompactionCheckpointStore.Service,
  layer: sidecarLayer,
  deps: [SchedulerService.node, Location.node],
})

export * as CheckpointStore from "./compaction-checkpoint-store"
