import { describe, expect } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Effect, Exit, Scope } from "effect"
import { McpCatalog } from "@/mcp/catalog"
import { type McpTool } from "@/mcp/index"
import { registerMcpServerTools } from "@/mcp/v2-registration"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode]), [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]),
)

const serverName = "fixture"
const sessionID = SessionV2.ID.make("ses_mcp_v2")
const agent = AgentV2.ID.make("build")
const assistantMessageID = SessionMessage.ID.make("msg_mcp_v2")

const defs: McpTool["def"][] = [
  { name: "text_tool", description: "returns text", inputSchema: { type: "object", properties: {} } },
  { name: "image_tool", description: "returns an image", inputSchema: { type: "object", properties: {} } },
  { name: "error_tool", description: "returns an error", inputSchema: { type: "object", properties: {} } },
]

const results: Record<string, unknown> = {
  text_tool: { content: [{ type: "text", text: "hello" }] },
  image_tool: { content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] },
  error_tool: { content: [{ type: "text", text: "boom" }], isError: true },
}

const fixtureTools: McpTool[] = defs.map((def) => ({
  def,
  client: {
    callTool: async ({ name }: { name: string }) => results[name],
  } as unknown as McpTool["client"],
}))

const v1Names = defs.map((def) => McpCatalog.toolName(serverName, def.name))

describe("registerMcpServerTools", () => {
  it.effect("registers tools under the names and namespaces V1 uses", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* registerMcpServerTools(serverName, fixtureTools).pipe(Scope.provide(scope))

      const materialized = yield* registry.materialize()
      expect(materialized.definitions.map((definition) => definition.name)).toEqual(v1Names)
      expect(materialized.definitions.map((definition) => definition.metadata?.namespace)).toEqual(
        fixtureTools.map(() => `mcp:${serverName}`),
      )

      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("settles calls through the shared transport and normalizes text, image, and error results", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* registerMcpServerTools(serverName, fixtureTools).pipe(Scope.provide(scope))
      const materialized = yield* registry.materialize()

      const textResult = yield* materialized.settle({
        sessionID,
        agent,
        assistantMessageID,
        call: { type: "tool-call", id: "call-text", name: v1Names[0]!, input: {} },
      })
      expect(textResult.result).toEqual({ type: "text", value: "hello" })

      const imageResult = yield* materialized.settle({
        sessionID,
        agent,
        assistantMessageID,
        call: { type: "tool-call", id: "call-image", name: v1Names[1]!, input: {} },
      })
      expect(imageResult.result).toEqual({
        type: "content",
        value: [{ type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png" }],
      })

      const errorResult = yield* materialized.settle({
        sessionID,
        agent,
        assistantMessageID,
        call: { type: "tool-call", id: "call-error", name: v1Names[2]!, input: {} },
      })
      expect(errorResult.result).toEqual({ type: "error", value: "boom" })

      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("excludes tools whose V1 permission action is denied", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* registerMcpServerTools(serverName, fixtureTools).pipe(Scope.provide(scope))

      const rules = v1Names.map((action) => ({ action, resource: "*", effect: "deny" as const }))
      const definitions = (yield* registry.materialize(rules)).definitions
      expect(definitions.map((definition) => definition.name)).toEqual([])

      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("removes registered tools when the registration scope closes", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* registerMcpServerTools(serverName, fixtureTools).pipe(Scope.provide(scope))
      expect((yield* registry.materialize()).definitions.map((definition) => definition.name)).toEqual(v1Names)

      yield* Scope.close(scope, Exit.void)
      expect((yield* registry.materialize()).definitions.map((definition) => definition.name)).toEqual([])
    }),
  )

  it.effect("reveals the previous registration when a newer scope closes", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const first = yield* Scope.make()
      const second = yield* Scope.make()
      const firstTools: McpTool[] = [
        {
          def: defs[0]!,
          client: {
            callTool: async () => ({ content: [{ type: "text", text: "hello" }] }),
          } as unknown as McpTool["client"],
        },
      ]
      const secondTools: McpTool[] = [
        {
          def: defs[0]!,
          client: {
            callTool: async () => ({ content: [{ type: "text", text: "world" }] }),
          } as unknown as McpTool["client"],
        },
      ]
      yield* registerMcpServerTools(serverName, firstTools).pipe(Scope.provide(first))
      yield* registerMcpServerTools(serverName, secondTools).pipe(Scope.provide(second))
      const materialized = yield* registry.materialize()
      const name = McpCatalog.toolName(serverName, "text_tool")

      const latest = yield* materialized.settle({
        sessionID,
        agent,
        assistantMessageID,
        call: { type: "tool-call", id: "call-latest", name, input: {} },
      })
      expect(latest.result).toEqual({ type: "text", value: "world" })

      yield* Scope.close(second, Exit.void)
      const revealed = yield* registry.materialize()
      const previous = yield* revealed.settle({
        sessionID,
        agent,
        assistantMessageID,
        call: { type: "tool-call", id: "call-previous", name, input: {} },
      })
      expect(previous.result).toEqual({ type: "text", value: "hello" })

      yield* Scope.close(first, Exit.void)
      expect((yield* registry.materialize()).definitions.map((definition) => definition.name)).toEqual([])
    }),
  )
})
