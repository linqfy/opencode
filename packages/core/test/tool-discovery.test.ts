import { describe, expect, test } from "bun:test"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolDiscovery } from "@opencode-ai/core/tool/discovery"
import { Effect, Schema } from "effect"

const tool = (description: string, namespace = "core") =>
  Tool.make({
    namespace,
    description,
    input: Schema.Struct({ path: Schema.String.annotate({ description: "Path to inspect" }) }),
    output: Schema.String,
    execute: () => Effect.succeed("ok"),
  })

describe("ToolDiscovery", () => {
  test("ranks unmaterialized tools by BM25 relevance", () => {
    const results = ToolDiscovery.search(
      "search source files",
      new Map([
        ["deploy", tool("Deploy a cloud service", "cloud")],
        ["glob", tool("Find source files matching a glob pattern")],
        ["websearch", tool("Search the public web")],
      ]),
    )

    expect(results.map((result) => result.name)).toEqual(["glob", "websearch"])
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0)
  })
})
