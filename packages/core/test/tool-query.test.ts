import { describe, expect, test } from "bun:test"
import { buildToolQuery } from "@opencode-ai/core/tool/query"

const tokens = (query: string | undefined) => query?.split(" ") ?? []

describe("buildToolQuery", () => {
  test("is deterministic for identical inputs", () => {
    const input = {
      agentDescription: "Writes TypeScript code",
      agentName: "build",
      lastUserText: "Refactor the file handling code",
    }
    expect(buildToolQuery(input)).toBe(buildToolQuery(input))
    expect(buildToolQuery({ ...input })).toBe(buildToolQuery(input))
  })

  test("returns undefined when there is no lastUserText signal", () => {
    expect(buildToolQuery({})).toBeUndefined()
    expect(buildToolQuery({ agentName: "build" })).toBeUndefined()
    expect(buildToolQuery({ agentDescription: "Reviews code" })).toBeUndefined()
    expect(buildToolQuery({ lastUserText: undefined })).toBeUndefined()
    expect(buildToolQuery({ lastUserText: "" })).toBeUndefined()
    expect(buildToolQuery({ lastUserText: "   " })).toBeUndefined()
  })

  test("never returns undefined when lastUserText carries a signal", () => {
    expect(buildToolQuery({ lastUserText: "!!!" })).toBeDefined()
    expect(buildToolQuery({ lastUserText: "Find the weather" })).toBeDefined()
  })

  test("extracts lowercase word keywords from the user text on word boundaries", () => {
    expect(buildToolQuery({ lastUserText: "Refactor the file handling code in src/index.ts" })).toBe(
      "refactor the file handling code in src index ts",
    )
  })

  test("caps the query at 12 tokens", () => {
    const query = buildToolQuery({
      lastUserText: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen",
    })
    expect(tokens(query)).toHaveLength(12)
  })

  test("includes agent name and description keywords after the user terms", () => {
    expect(
      buildToolQuery({
        agentDescription: "Reviews pull requests for correctness",
        agentName: "reviewer",
        lastUserText: "Check the diff",
      }),
    ).toBe("check the diff reviewer reviews pull requests for correctness")
  })

  test("bounds the total query at 12 tokens when the agent description is long", () => {
    const query = buildToolQuery({
      agentDescription: "a very long agent description that keeps going and going with many many words",
      agentName: "reviewer",
      lastUserText: "short task",
    })
    expect(tokens(query)).toHaveLength(12)
    expect(tokens(query).slice(0, 3)).toEqual(["short", "task", "reviewer"])
  })
})
