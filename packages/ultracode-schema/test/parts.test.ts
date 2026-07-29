import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { UltraContentPart, UltraContentPartJson, ToolResultMeta, ReasoningProvenance } from "../src/content/parts"

describe("UltraContentPart", () => {
  test("decodes imported llm parts through the extended union", () => {
    const text = Schema.decodeUnknownSync(UltraContentPart)({ type: "text", text: "hello" })
    expect(text.type).toBe("text")
    const media = Schema.decodeUnknownSync(UltraContentPart)({ type: "media", mediaType: "image/png", data: "AQI=" })
    expect(media.type).toBe("media")
  })

  test("decodes refusal, citation, and artifact-ref parts", () => {
    const refusal = Schema.decodeUnknownSync(UltraContentPart)({ type: "refusal", text: "cannot comply" })
    expect(refusal.type).toBe("refusal")
    const citation = Schema.decodeUnknownSync(UltraContentPart)({
      type: "citation",
      quotedText: "exact words",
      url: "https://example.com",
      trust: "untrusted",
    })
    expect(citation.type).toBe("citation")
    const artifact = Schema.decodeUnknownSync(UltraContentPart)({
      type: "artifact-ref",
      artifactId: "art_01J",
      mime: "text/plain",
      byteLength: 8192,
      hash: "a".repeat(64),
    })
    expect(artifact.type).toBe("artifact-ref")
  })

  test("round-trips through JSON preserving structure", () => {
    const part = { type: "artifact-ref", artifactId: "art_01J", mime: "text/plain", byteLength: 10, hash: "a".repeat(64) } as const
    const json = Schema.encodeSync(UltraContentPartJson)(part)
    const back = Schema.decodeUnknownSync(UltraContentPartJson)(json)
    expect(back).toEqual(part)
  })

  test("rejects an unknown part type", () => {
    expect(() => Schema.decodeUnknownSync(UltraContentPart)({ type: "telepathy", data: {} })).toThrow()
  })
})

describe("ToolResultMeta", () => {
  test("accepts every status value from the spec", () => {
    for (const status of ["success", "error", "denied", "interrupted", "partial"] as const) {
      const decoded = Schema.decodeUnknownSync(ToolResultMeta)({ toolCallId: "call_1", status })
      expect(decoded.status).toBe(status)
    }
  })

  test("rejects an unknown status", () => {
    expect(() => Schema.decodeUnknownSync(ToolResultMeta)({ toolCallId: "call_1", status: "fine" })).toThrow()
  })
})

describe("ReasoningProvenance", () => {
  test("records provider, endpoint family, model, and protocol version", () => {
    const decoded = Schema.decodeUnknownSync(ReasoningProvenance)({
      provider: "anthropic",
      endpointFamily: "anthropic-messages",
      model: "claude-opus-4-8",
      protocolVersion: "2025-11-01",
    })
    expect(decoded.endpointFamily).toBe("anthropic-messages")
  })
})
