import { MemoryDisabledError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

// The durable memory review store is served by the opencode-sidecar wiring
// (SchedulerService); the standalone server has no sidecar, so every memory
// endpoint fails closed as disabled rather than advertising an empty store.
const disabled = () =>
  Effect.fail(new MemoryDisabledError({ message: "Memory is disabled" }))

export const MemoryHandler = HttpApiBuilder.group(Api, "server.memory", (handlers) =>
  handlers
    .handle("memory.list", disabled)
    .handle("memory.get", disabled)
    .handle("memory.patch", disabled)
    .handle("memory.delete", disabled),
)
