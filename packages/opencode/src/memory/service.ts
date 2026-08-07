import { Context, Effect, Layer } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionStore } from "@opencode-ai/core/session/store"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import type { Node } from "@opencode-ai/core/effect/layer-node"
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

// Production wiring uses a fails-closed extractor until an LLM-backed seam is
// available; claimed jobs fail without writing candidate records.
export const node = makeGlobalNode({
  service: Service,
  layer: layerWith({ extract: async () => undefined }).pipe(Layer.orDie),
  deps: [SchedulerService.node, SessionStore.node, EventV2.node],
}) as unknown as Node<Service, never>

export * as MemoryService from "./service"
