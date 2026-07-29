import { describe, expect, test } from "bun:test"
import { buildSystemPlan, compileContext, estimateTokens, IDENTITY_BLOCK } from "../src/index"

describe("buildSystemPlan + compileContext integration", () => {
  test("assembles kernel + environment + instructions + manifests in stability order", () => {
    const compiled = compileContext(
      buildSystemPlan({
        environment: ["env-block"],
        instructions: ["instruction-block"],
        mcpInstructions: "mcp-block",
        skills: "skills-block",
        modelContextLimit: 200_000,
        outputReserve: 32_000,
        userContentTokens: 0,
      }),
    )
    // immutable kernel first, then session-stable env, repository-stable instructions, registry-stable manifests
    expect(compiled.system[0]).toBe(IDENTITY_BLOCK)
    expect(compiled.system).toContain("env-block")
    expect(compiled.system).toContain("instruction-block")
    expect(compiled.system).toContain("mcp-block")
    expect(compiled.system).toContain("skills-block")
    expect(compiled.blocks[0]?.stability).toBe("immutable")
    expect(compiled.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  test("adds the structured-output block only when requested", () => {
    const withSo = compileContext(buildSystemPlan({ environment: [], instructions: [], structuredOutput: true, modelContextLimit: 200_000, outputReserve: 32_000, userContentTokens: 0 }))
    const withoutSo = compileContext(buildSystemPlan({ environment: [], instructions: [], modelContextLimit: 200_000, outputReserve: 32_000, userContentTokens: 0 }))
    expect(withSo.system.length).toBe(withoutSo.system.length + 1)
  })

  test("estimateTokens is a conservative chars/4 estimate", () => {
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
  })
})
