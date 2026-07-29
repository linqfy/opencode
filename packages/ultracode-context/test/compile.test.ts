import { describe, expect, test } from "bun:test"
import { compileContext, CompilerError } from "../src/compiler/compile"
import type { ContextBlock, ContextPlan } from "../src/compiler/types"

const block = (partial: Partial<ContextBlock> & { id: string }): ContextBlock => ({
  stability: "dynamic",
  trust: "privileged",
  content: "content",
  estimatedTokens: 10,
  provenance: "test",
  inclusionReason: "test",
  ...partial,
})

const plan = (blocks: ContextBlock[], overrides: Partial<ContextPlan> = {}): ContextPlan => ({
  blocks,
  modelContextLimit: 200_000,
  outputReserve: 32_000,
  userContentTokens: 100,
  ...overrides,
})

describe("compileContext", () => {
  test("orders blocks by stability rank then id and fingerprints deterministically", () => {
    const a = plan([
      block({ id: "z-dynamic", stability: "dynamic" }),
      block({ id: "identity", stability: "immutable" }),
      block({ id: "a-dynamic", stability: "dynamic" }),
    ])
    const first = compileContext(a)
    expect(first.blocks.map((b) => b.id)).toEqual(["identity", "a-dynamic", "z-dynamic"])

    // Same blocks, different input order -> identical fingerprint.
    const b = plan([
      block({ id: "a-dynamic", stability: "dynamic" }),
      block({ id: "identity", stability: "immutable" }),
      block({ id: "z-dynamic", stability: "dynamic" }),
    ])
    expect(compileContext(b).fingerprint).toBe(first.fingerprint)
  })

  test("rejects untrusted content in a privileged stability tier", () => {
    const p = plan([block({ id: "bad", stability: "immutable", trust: "untrusted" })])
    expect(() => compileContext(p)).toThrow(CompilerError)
  })

  test("allows untrusted content in a dynamic tier", () => {
    const p = plan([block({ id: "evidence", stability: "dynamic", trust: "untrusted" })])
    expect(() => compileContext(p)).not.toThrow()
  })

  test("throws rather than silently trimming when non-reducible input exceeds the budget", () => {
    const huge = block({ id: "identity", stability: "immutable", estimatedTokens: 200_000 })
    const p = plan([huge], { modelContextLimit: 10_000, outputReserve: 1_000 })
    expect(() => compileContext(p)).toThrow(/exceeds input budget/)
  })

  test("places the cache boundary before the first non-cache-stable block", () => {
    const p = plan([
      block({ id: "identity", stability: "immutable" }),
      block({ id: "instructions", stability: "repository-stable" }),
      block({ id: "tail", stability: "turn-stable" }),
      block({ id: "evidence", stability: "dynamic" }),
    ])
    const compiled = compileContext(p)
    // immutable + repository-stable are cache-stable; turn-stable is the first that is not.
    expect(compiled.cacheBoundary).toBe(2)
    expect(compiled.blocks[compiled.cacheBoundary]?.id).toBe("tail")
  })

  test("system is the ordered block contents and totalTokens includes user content", () => {
    const p = plan([block({ id: "identity", stability: "immutable", content: "I am UltraCode", estimatedTokens: 5 })], {
      userContentTokens: 42,
    })
    const compiled = compileContext(p)
    expect(compiled.system).toEqual(["I am UltraCode"])
    expect(compiled.totalTokens).toBe(47)
  })
})
