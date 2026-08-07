export * as McpV2Tools from "./v2-location"

import { Effect, Exit, Layer, Scope, Semaphore, Stream } from "effect"
import { makeGlobalNode, makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { McpEvent } from "@opencode-ai/schema/mcp-event"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tools } from "@opencode-ai/core/tool/tools"
import { MCP, type McpTool } from "."
import { registerMcpServerTools } from "./v2-registration"

// MCP.Service is provided by the untagged MCP.node, which the location graph would
// otherwise build fresh per Location. This tagged-global node re-exports the same MCP
// layer so the Location adapter reads the process-shared MCP connections.
export const globalNode = makeGlobalNode({
  service: MCP.Service,
  layer: Layer.effect(MCP.Service, Effect.gen(function* () {
    return yield* MCP.Service
  })).pipe(Layer.provideMerge(LayerNode.compile(MCP.node))),
  deps: [],
})

const layer = Layer.effect(
  Tools.Service,
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const mcp = yield* MCP.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    const syncLock = yield* Semaphore.make(1)
    let registered: Scope.Closeable | undefined
    const toolsService = Tools.Service.of({ register: registry.register })

    // Re-register every connected server under one Location-owned scope. The lock
    // serializes boot and ToolsChanged syncs so a close-then-open cannot interleave.
    const sync = Effect.fn("McpV2Tools.sync")(function* () {
      if (registered) yield* Scope.close(registered, Exit.void).pipe(Effect.ignore)
      registered = undefined
      const byServer = yield* connectedServers(mcp)
      if (byServer.length === 0) return
      const next = yield* Scope.make()
      registered = next
      yield* Effect.forEach(
        byServer,
        ([serverName, serverTools]) =>
          registerMcpServerTools(serverName, serverTools).pipe(
            Effect.provideService(Tools.Service, toolsService),
            // One server with an unregisterable tool name must not take down the rest.
            Effect.catchCause((cause) =>
              Effect.logError("MCP tool registration failed", { server: serverName, cause }).pipe(Effect.asVoid),
            ),
          ),
        { concurrency: "unbounded" },
      ).pipe(Scope.provide(next))
    })

    yield* syncLock.withPermit(sync().pipe(Effect.catchCause(() => Effect.void)))
    yield* events.subscribe(McpEvent.ToolsChanged).pipe(
      Stream.runForEach(() =>
        syncLock.withPermit(sync()).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("MCP tool re-registration failed", { cause }).pipe(Effect.asVoid),
          ),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        if (registered) yield* Scope.close(registered, Exit.void).pipe(Effect.ignore)
      }),
    )

    return toolsService
  }),
)

export const node = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ToolRegistry.node, globalNode, EventV2.node],
})

// Group the connected tools from MCP.tools() back by server using client identity.
const connectedServers = Effect.fnUntraced(function* (mcp: MCP.Interface) {
  const tools = yield* mcp.tools()
  const clients = yield* mcp.clients()
  const byServer: Array<[string, McpTool[]]> = []
  for (const [serverName, client] of Object.entries(clients)) {
    const serverTools = Object.values(tools).filter((tool) => tool.client === client)
    if (serverTools.length > 0) byServer.push([serverName, serverTools])
  }
  return byServer
})
