import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { UltraContentArrayJson } from "../src/content/parts"

const MessageArrayJson = UltraContentArrayJson

describe("canonical transcript preservation", () => {
  const parts: unknown[] = [
    { type: "text", text: "plain text" },
    { type: "media", mediaType: "image/png", data: "AQI=" },
    { type: "media", mediaType: "application/pdf", data: "BQY=", filename: "doc.pdf" },
    { type: "media", mediaType: "audio/mpeg", data: "Bwg=" },
    { type: "media", mediaType: "video/mp4", data: "CQo=" },
    { type: "tool-call", id: "call_1", name: "read", input: { path: "/x" } },
    { type: "tool-result", id: "call_1", name: "read", result: { type: "text", value: "ok" } },
    { type: "reasoning", text: "thought", encrypted: "sig" },
    { type: "refusal", text: "cannot comply" },
    { type: "citation", quotedText: "quoted", url: "https://example.com", trust: "untrusted" },
    { type: "artifact-ref", artifactId: "art_01J", mime: "text/plain", byteLength: 5, hash: "a".repeat(64) },
  ]

  test("every model input type survives a JSON round trip losslessly", () => {
    const decoded = Schema.decodeUnknownSync(MessageArrayJson)(JSON.stringify(parts))
    expect(decoded.length).toBe(parts.length)
    const reencoded = Schema.encodeSync(MessageArrayJson)(decoded)
    const roundTripped = Schema.decodeUnknownSync(MessageArrayJson)(reencoded)
    expect(roundTripped).toEqual(decoded)
    expect(roundTripped.map((part) => part.type)).toEqual([
      "text",
      "media",
      "media",
      "media",
      "media",
      "tool-call",
      "tool-result",
      "reasoning",
      "refusal",
      "citation",
      "artifact-ref",
    ])
  })

  test("media modality is preserved by mediaType through the round trip", () => {
    const decoded = Schema.decodeUnknownSync(MessageArrayJson)(JSON.stringify(parts))
    const mediaTypes = decoded.filter((part) => part.type === "media").map((part) => (part as { mediaType: string }).mediaType)
    expect(mediaTypes).toEqual(["image/png", "application/pdf", "audio/mpeg", "video/mp4"])
  })
})
