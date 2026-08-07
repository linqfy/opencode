import { describe, expect } from "bun:test"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { McpEvent } from "@opencode-ai/schema/mcp-event"
import { Effect, Layer } from "effect"
import { MCP, type McpTool } from "@/mcp/index"
import { McpV2Tools } from "@/mcp/v2-location"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

let tools: Record<string, McpTool> = {}
let clients: Record<string, McpTool["client"]> = {}

const setServer = (serverName: string, defs: McpTool["def"][]) => {
  const client = { server: serverName } as unknown as McpTool["client"]
  clients[serverName] = client
  for (const def of defs) tools[`${serverName}_${def.name}`] = { def, client }
}

const clearServers = () => {
  tools = {}
  clients = {}
}

const fakeMcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed(clients),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed(tools),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: {} }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.succeed({ authorizationUrl: "", oauthState: "" }),
    authenticate: () => Effect.succeed({ status: "connected" }),
    finishAuth: () => Effect.succeed({ status: "connected" }),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node]),
    [
      [ToolRegistry.toolsNode, McpV2Tools.node],
      [McpV2Tools.globalNode, fakeMcp],
    ],
  ),
)

const toolNames = (registry: ToolRegistry.Interface) =>
  registry.materialize().pipe(Effect.map((materialized) => materialized.definitions.map((definition) => definition.name)))

const serverToolNames = (registry: ToolRegistry.Interface, serverName: string) =>
  toolNames(registry).pipe(Effect.map((names) => names.filter((name) => name.startsWith(`${serverName}_`))))

const withLocation = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    return yield* body(registry)
  }).pipe(
    Effect.scoped,
    Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
  )

describe("McpV2Tools location adapter", () => {
  it.live("registers the connected MCP server tools into the Location's ToolRegistry", () =>
    Effect.gen(function* () {
      clearServers()
      setServer("fixture", [
        { name: "text_tool", description: "returns text", inputSchema: { type: "object", properties: {} } },
      ])
      const directory = yield* Effect.promise(() => tmpdir())
      try {
        const names = yield* withLocation(directory.path, (registry) => serverToolNames(registry, "fixture"))
        expect(names).toEqual(["fixture_text_tool"])
      } finally {
        yield* Effect.promise(() => directory[Symbol.asyncDispose]())
      }
    }),
  )

  it.live("re-registers on ToolsChanged and removes disconnected servers", () =>
    Effect.gen(function* () {
      clearServers()
      setServer("fixture", [
        { name: "text_tool", description: "returns text", inputSchema: { type: "object", properties: {} } },
      ])
      const directory = yield* Effect.promise(() => tmpdir())
      try {
        const events = yield* EventV2.Service
        yield* events.publish(McpEvent.ToolsChanged, { server: "fixture" })
        yield* withLocation(directory.path, (registry) =>
          pollWithTimeout(
            serverToolNames(registry, "fixture").pipe(Effect.map((names) => (names.includes("fixture_text_tool") ? names : undefined))),
            "fixture tools never registered",
          ).pipe(Effect.asVoid),
        )

        setServer("fixture", [
          { name: "text_tool", description: "returns text", inputSchema: { type: "object", properties: {} } },
          { name: "image_tool", description: "returns an image", inputSchema: { type: "object", properties: {} } },
        ])
        yield* events.publish(McpEvent.ToolsChanged, { server: "fixture" })
        yield* withLocation(directory.path, (registry) =>
          pollWithTimeout(
            serverToolNames(registry, "fixture").pipe(Effect.map((names) => (names.includes("fixture_image_tool") ? names : undefined))),
            "updated tools never registered",
          ).pipe(Effect.asVoid),
        )

        clearServers()
        yield* events.publish(McpEvent.ToolsChanged, { server: "fixture" })
        const finalNames = yield* withLocation(directory.path, (registry) =>
          pollWithTimeout(
            serverToolNames(registry, "fixture").pipe(Effect.map((names) => (names.length === 0 ? names : undefined))),
            "disconnected tools never removed",
          ),
        )
        expect(finalNames).toEqual([])
      } finally {
        yield* Effect.promise(() => directory[Symbol.asyncDispose]())
      }
    }),
  )

  it.live("contains a server whose tool names fail validation so healthy servers still register", () =>
    Effect.gen(function* () {
      clearServers()
      setServer("3d-modeling", [{ name: "render", description: "render", inputSchema: { type: "object", properties: {} } }])
      setServer("healthy", [{ name: "search", description: "search", inputSchema: { type: "object", properties: {} } }])
      const directory = yield* Effect.promise(() => tmpdir())
      try {
        const mcpNames = yield* withLocation(directory.path, (registry) =>
          pollWithTimeout(
            serverToolNames(registry, "healthy").pipe(Effect.map((names) => (names.includes("healthy_search") ? names : undefined))),
            "healthy server tools never registered",
          ).pipe(Effect.map((names) => names.filter((name) => name.startsWith("healthy_")))),
        )
        expect(mcpNames).toEqual(["healthy_search"])
        const badNames = yield* withLocation(directory.path, (registry) => serverToolNames(registry, "3d_modeling"))
        expect(badNames).toEqual([])
      } finally {
        yield* Effect.promise(() => directory[Symbol.asyncDispose]())
      }
    }),
  )
})
