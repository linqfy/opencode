import { describe, expect, test } from "bun:test"
import { canonicalStringify, fingerprint } from "../src/compiler/fingerprint"
import { BEHAVIORAL_INVARIANTS, IDENTITY_BLOCK } from "../src/compiler/kernel"

describe("canonicalStringify", () => {
  test("sorts object keys so insertion order does not matter", () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }))
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  test("preserves array order but sorts nested object keys", () => {
    expect(canonicalStringify([{ z: 1, a: 2 }, 3])).toBe('[{"a":2,"z":1},3]')
  })

  test("handles primitives and null", () => {
    expect(canonicalStringify(null)).toBe("null")
    expect(canonicalStringify("x")).toBe('"x"')
    expect(canonicalStringify(5)).toBe("5")
  })
})

describe("fingerprint", () => {
  test("is a 64-char hex sha256", () => {
    expect(fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })

  test("is stable across key order", () => {
    expect(fingerprint({ a: 1, b: [1, 2, { d: 4, c: 3 }] })).toBe(fingerprint({ b: [1, 2, { c: 3, d: 4 }], a: 1 }))
  })

  test("changes when content changes", () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }))
  })
})

describe("kernel", () => {
  test("identity and behavioral invariants are non-empty privileged text", () => {
    expect(IDENTITY_BLOCK.length).toBeGreaterThan(0)
    expect(BEHAVIORAL_INVARIANTS).toContain("untrusted data")
    expect(BEHAVIORAL_INVARIANTS).toContain("smallest coherent implementation")
  })
})
