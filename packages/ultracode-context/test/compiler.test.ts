import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { compileSystemPrompt, STRUCTURED_OUTPUT_SYSTEM_PROMPT } from "../src/compiler"

describe("compileSystemPrompt", () => {
  test("assembles deterministic blocks in prompt order", async () => {
    const result = await Effect.runPromise(
      compileSystemPrompt({
        agent: "build",
        model: "provider/model",
        permission: [],
        environment: ["environment", "references"],
        instructions: ["instructions"],
        mcpInstructions: "mcp",
        skills: "skills",
        format: { type: "text" },
      }),
    )

    expect(result).toEqual(["environment", "references", "instructions", "mcp", "skills"])
  })

  test("adds the structured-output instruction only for JSON schema output", async () => {
    const result = await Effect.runPromise(
      compileSystemPrompt({
        agent: "build",
        model: "provider/model",
        environment: [],
        instructions: [],
        format: { type: "json_schema" },
      }),
    )

    expect(result).toEqual([STRUCTURED_OUTPUT_SYSTEM_PROMPT])
  })
})
