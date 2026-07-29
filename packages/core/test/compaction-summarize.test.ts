import { describe, expect, test } from "bun:test"
import { checkpointPrompt, parseCheckpoint, serializeCheckpoint } from "../src/session/compaction-summarize"
import type { CompactionCheckpoint } from "@ultracode/context"

describe("parseCheckpoint", () => {
  test("parses a valid JSON checkpoint", () => {
    const json = JSON.stringify({ objective: "build it", completed: ["a"], constraints: [], decisions: [], workingSet: [], facts: [], toolArtifacts: [], tests: [], errors: [], pending: ["b"], approvalState: [], agentLineage: [] })
    const checkpoint = parseCheckpoint(json)
    expect(checkpoint?.objective).toBe("build it")
    expect(checkpoint?.pending).toEqual(["b"])
  })

  test("extracts JSON from a fenced code block", () => {
    const text = `Here you go:\n\`\`\`json\n${JSON.stringify({ objective: "x", completed: [], constraints: [], decisions: [], workingSet: [], facts: [], toolArtifacts: [], tests: [], errors: [], pending: [], approvalState: [], agentLineage: [] })}\n\`\`\``
    expect(parseCheckpoint(text)?.objective).toBe("x")
  })

  test("returns undefined on unparseable output", () => {
    expect(parseCheckpoint("not json at all")).toBeUndefined()
  })
})

describe("serializeCheckpoint", () => {
  test("renders a stable summary string containing the objective and pending work", () => {
    const checkpoint: CompactionCheckpoint = {
      objective: "build the feature", completed: ["scaffold"], constraints: ["no deps"], decisions: [], workingSet: [],
      facts: [], toolArtifacts: [], tests: [], errors: [], pending: ["wire it"], approvalState: [], agentLineage: [],
    }
    const summary = serializeCheckpoint(checkpoint)
    expect(summary).toContain("build the feature")
    expect(summary).toContain("scaffold")
    expect(summary).toContain("wire it")
  })
})

describe("checkpointPrompt", () => {
  test("asks for JSON matching the checkpoint schema and includes the conversation", () => {
    const prompt = checkpointPrompt(["[User]: hello", "[Assistant]: hi"])
    expect(prompt).toContain("objective")
    expect(prompt).toContain("[User]: hello")
    expect(prompt.toLowerCase()).toContain("json")
  })
})
