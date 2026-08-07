import { Context, Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionStore } from "@opencode-ai/core/session/store"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { SchedulerService } from "@/agent/scheduler-service"
import { subscribeMemoryTriggers } from "./triggers"
import { memoryClaimGuard, runMemoryWorker, type MemoryExtractSeam } from "./worker"

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryService") {}

export const layerWith = (input: { readonly extract: MemoryExtractSeam }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const scheduler = yield* SchedulerService.Service
      const sessionStore = yield* SessionStore.Service
      const events = yield* EventV2.Service
      const config = yield* Config.Service
      const memoryEnabled = (yield* config.entries()).some(
        (entry) => entry.type === "document" && entry.info.memory?.enabled === true,
      )
      if (!memoryEnabled) {
        yield* Effect.logInfo("memory extraction disabled: memory.enabled is not set")
        return Service.of({})
      }
      const client = yield* scheduler.events.pipe(
        Effect.match({
          onFailure: () => null,
          onSuccess: (value) => value,
        }),
      )
      if (client === null) {
        yield* Effect.logInfo("memory extraction disabled: scheduler sidecar unavailable")
        return Service.of({})
      }
      const unsubscribe = yield* subscribeMemoryTriggers({ client, events, claim: memoryClaimGuard() })
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* runMemoryWorker({
        client,
        sessionStore,
        extract: input.extract,
        claim: memoryClaimGuard(),
        now: () => Date.now(),
      }).pipe(Effect.forkScoped)
      return Service.of({})
    }),
  )

// Config.Service is location-scoped; the global worker reads the config of the
// process's working directory, so bind it into the app graph through the
// LocationServiceMap instead of a raw location node.
const defaultConfig = Layer.unwrap(
  Effect.map(LocationServiceMap.Service, (map) => map.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }))),
)
const defaultConfigNode = makeGlobalNode({
  service: Config.Service,
  layer: defaultConfig,
  deps: [LocationServiceMap.node],
})

// Production wiring uses a fails-closed extractor until an LLM-backed seam is
// available; claimed jobs fail without writing candidate records.
export const node = LayerNode.make({
  service: Service,
  layer: layerWith({ extract: async () => undefined }).pipe(Layer.orDie),
  deps: [defaultConfigNode, SchedulerService.node, SessionStore.node, EventV2.node],
})

export * as MemoryService from "./service"
