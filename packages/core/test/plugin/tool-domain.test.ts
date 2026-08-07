import { describe, expect } from "bun:test"
import { define } from "@opencode-ai/plugin/v2/effect"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolDomain } from "@opencode-ai/core/tool/domain"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { State } from "@opencode-ai/core/state"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { Effect, Exit, Schema, Scope } from "effect"
import { testEffect } from "../lib/effect"
import { toolDefinitions } from "../lib/tool"
import { PluginTestLayer } from "./fixture"

const tool = (description: string, namespace = "plugin:fixture") =>
  Tool.make({
    namespace,
    description,
    input: Schema.Struct({ query: Schema.String }),
    output: Schema.String,
    execute: () => Effect.succeed("ok"),
  })

const toolLayer = AppNodeBuilder.build(
  LayerNode.group([ApplicationTools.node, ToolRegistry.node, ToolRegistry.toolsNode, ToolDomain.node]),
  [[ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig]],
)
const it = testEffect(toolLayer)
const itHost = testEffect(PluginTestLayer)

describe("ToolDomain", () => {
  it.effect("registers a plugin tool at boot and materializes it with the plugin namespace", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const domain = yield* ToolDomain.Service
      const registry = yield* ToolRegistry.Service

      yield* domain.transform((draft) => draft.register("weather", tool("Get the current weather"))).pipe(
        Scope.provide(scope),
      )

      expect(yield* toolDefinitions(registry)).toMatchObject([
        { name: "weather", description: "Get the current weather", metadata: { namespace: "plugin:fixture" } },
      ])

      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )

  it.effect("reveals the previous registration when a later scope closes", () =>
    Effect.gen(function* () {
      const first = yield* Scope.make()
      const second = yield* Scope.make()
      const domain = yield* ToolDomain.Service
      const registry = yield* ToolRegistry.Service

      yield* domain.transform((draft) => draft.register("weather", tool("First weather"))).pipe(Scope.provide(first))
      yield* domain.transform((draft) => {
        draft.register("weather", tool("Second weather"))
        draft.register("news", tool("Latest news"))
      }).pipe(Scope.provide(second))

      expect((yield* toolDefinitions(registry)).map((definition) => definition.name)).toEqual(["weather", "news"])
      expect((yield* toolDefinitions(registry)).find((definition) => definition.name === "weather")?.description).toBe(
        "Second weather",
      )

      yield* Scope.close(second, Exit.void)
      expect((yield* toolDefinitions(registry)).map((definition) => definition.name)).toEqual(["weather"])
      expect((yield* toolDefinitions(registry)).find((definition) => definition.name === "weather")?.description).toBe(
        "First weather",
      )

      yield* Scope.close(first, Exit.void)
      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )

  it.effect("coalesces a batch of two transforms into one effective set", () =>
    Effect.gen(function* () {
      const domain = yield* ToolDomain.Service
      const registry = yield* ToolRegistry.Service

      yield* State.batch(
        Effect.gen(function* () {
          yield* domain.transform((draft) => draft.register("weather", tool("Get the weather")))
          yield* domain.transform((draft) => draft.register("news", tool("Get the news")))
        }),
      )

      expect((yield* toolDefinitions(registry)).map((definition) => definition.name).toSorted()).toEqual([
        "news",
        "weather",
      ])
    }),
  )
})

describe("PluginHost.tool", () => {
  itHost.effect("wires the tool transform domain for a fixture plugin", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const registry = yield* ToolRegistry.Service
      const host = yield* PluginHost.make(plugin)

      const fixture = define({
        id: "tool-fixture",
        effect: (ctx) =>
          Effect.gen(function* () {
            yield* ctx.tool.transform((draft) => {
              draft.register("weather", {
                namespace: "plugin:tool-fixture",
                description: "Get the current weather",
                input: Schema.Struct({ city: Schema.String }),
                output: Schema.String,
                execute: ({ city }) => Effect.succeed(`sunny in ${city}`),
              })
            })
            yield* ctx.tool.transform((draft) => {
              draft.register("news", {
                namespace: "plugin:tool-fixture",
                description: "Read the latest news",
                input: Schema.Struct({ topic: Schema.String }),
                output: Schema.String,
                execute: () => Effect.succeed("no news yet"),
              })
            })
          }),
      })

      yield* fixture.effect(host)

      const definitions = yield* toolDefinitions(registry)
      expect(definitions.map((definition) => definition.name).toSorted()).toEqual(["news", "weather"])
      expect(definitions.find((definition) => definition.name === "weather")).toMatchObject({
        description: "Get the current weather",
        metadata: { namespace: "plugin:tool-fixture" },
      })
    }),
  )
})
