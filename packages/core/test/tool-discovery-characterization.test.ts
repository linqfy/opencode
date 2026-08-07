import { describe, expect, test } from "bun:test"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolDiscovery } from "@opencode-ai/core/tool/discovery"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Effect, Schema } from "effect"
import { testEffect } from "./lib/effect"

const harness = () =>
  testEffect(
    AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, ToolRegistry.node, ToolRegistry.toolsNode]), [
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ]),
  )

const tool = (description: string, namespace = "core") =>
  Tool.make({
    namespace,
    description,
    input: Schema.Struct({ path: Schema.String.annotate({ description: "Path to inspect" }) }),
    output: Schema.String,
    execute: () => Effect.succeed("ok"),
  })

const defs = (
  registry: ToolRegistry.Interface,
  permissions?: Parameters<typeof registry.materialize>[0],
  query?: string,
) => registry.materialize(permissions, query).pipe(Effect.map((m) => m.definitions))

const names = (definitions: ReadonlyArray<{ readonly name: string }>) => definitions.map((d) => d.name)

describe("ToolDiscovery.search", () => {
  test("returns [] for empty or whitespace-only queries", () => {
    const tools = new Map([["glob", tool("Find source files matching a glob pattern")]])
    expect(ToolDiscovery.search("", tools)).toEqual([])
    expect(ToolDiscovery.search("   ", tools)).toEqual([])
  })

  test("sorts results by score descending, then name ascending for tied scores", () => {
    const results = ToolDiscovery.search(
      "frobnicate",
      new Map([
        ["zeta", tool("frobnicate the widget")],
        ["alpha", tool("frobnicate the widget")],
        ["high", tool("frobnicate frobnicate frobnicate the widget")],
        ["mid", tool("frobnicate frobnicate the widget")],
      ]),
    )
    expect(results.map((result) => result.name)).toEqual(["high", "mid", "alpha", "zeta"])
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score)
    expect(results[1]!.score).toBeGreaterThan(results[2]!.score)
    expect(results[2]!.score).toBe(results[3]!.score)
  })
})

describe("ToolRegistry.materialize", () => {
  const it = harness()

  it.effect("materializes every permitted tool and no search_tools when query is absent", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      yield* applications.register({
        qa_read: tool("read the alpha file"),
        qb_write: tool("write the beta file"),
      })

      const withoutArgs = yield* defs(registry)
      expect(names(withoutArgs).toSorted()).toEqual(["qa_read", "qb_write"])
      expect(names(withoutArgs)).not.toContain("search_tools")

      const explicitUndefined = yield* defs(registry, undefined, undefined)
      expect(names(explicitUndefined).toSorted()).toEqual(["qa_read", "qb_write"])
      expect(names(explicitUndefined)).not.toContain("search_tools")
    }),
  )

  it.effect("materializes the top-5 matches with search_tools appended when query matches", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      yield* applications.register({
        top_alpha: tool("frobnicate the widget"),
        top_beta: tool("frobnicate the widget"),
        top_delta: tool("frobnicate the widget"),
        top_epsilon: tool("frobnicate the widget"),
        top_eta: tool("frobnicate the widget"),
        top_gamma: tool("frobnicate the widget"),
        top_zeta: tool("frobnicate the widget"),
      })

      const definitions = yield* defs(registry, undefined, "frobnicate")
      expect(names(definitions)).toEqual(["top_alpha", "top_beta", "top_delta", "top_epsilon", "top_eta", "search_tools"])
      const search = definitions.find((d) => d.name === "search_tools")!
      expect(search.metadata).toMatchObject({ namespace: "system", concurrencySafe: true })
      expect(search.description).toContain("not currently loaded")
    }),
  )

  it.effect("materializes only search_tools when query matches nothing", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      yield* applications.register({ only_nomatch: tool("read something unrelated") })

      expect(names(yield* defs(registry, undefined, "no_match_zzz_123"))).toEqual(["search_tools"])
    }),
  )

  it.effect("treats an empty or whitespace query as no matches but still injects search_tools", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      yield* applications.register({ empty_match: tool("reads empty query data") })

      expect(names(yield* defs(registry, undefined, ""))).toEqual(["search_tools"])
      expect(names(yield* defs(registry, undefined, "   "))).toEqual(["search_tools"])
    }),
  )

  it.effect("orders query results by descending score before slicing to the top 5", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      yield* applications.register({
        score_weak: tool("quux filler filler filler filler"),
        score_strong: tool("quux quux quux quux filler"),
        score_medium: tool("quux quux filler filler filler"),
      })

      expect(names(yield* defs(registry, undefined, "quux"))).toEqual(["score_strong", "score_medium", "score_weak", "search_tools"])
    }),
  )

  it.effect("never materializes a wholly-denied tool, with or without a query", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      yield* applications.register({
        secret_denied: tool("deny me here"),
        allowed_reader: tool("read public data"),
      })

      expect(names(yield* defs(registry, [{ action: "secret_denied", resource: "*", effect: "deny" }]))).toEqual([
        "allowed_reader",
      ])
      expect(names(yield* defs(registry, [{ action: "secret_denied", resource: "*", effect: "deny" }], "deny"))).toEqual([
        "search_tools",
      ])
    }),
  )

  it.effect("denies a tool via its declared permission action even when the query matches it", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      yield* applications.register({
        guarded_write: Tool.withPermission(tool("guarded secret write access"), "edit"),
      })

      expect(names(yield* defs(registry, [{ action: "edit", resource: "*", effect: "deny" }]))).toEqual([])
      expect(names(yield* defs(registry, [{ action: "edit", resource: "*", effect: "deny" }], "guarded"))).toEqual([
        "search_tools",
      ])
    }),
  )
})
