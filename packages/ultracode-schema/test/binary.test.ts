import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { BinaryLocator, BinaryMetadata, BinaryMetadataJson } from "../src/content/binary"

const sha = "a".repeat(64)

describe("BinaryLocator", () => {
  test("accepts every locator variant", () => {
    const variants = [
      { type: "inline-bytes", bytes: new Uint8Array([1, 2, 3]) },
      { type: "inline-base64", base64: "AQI=" },
      { type: "scoped-handle", handle: "hnd_123" },
      { type: "uri", uri: "https://example.com/file.pdf" },
      { type: "provider-file-id", id: "file-abc123" },
      { type: "artifact-id", id: "art_01J" },
    ] as const
    for (const variant of variants) {
      const decoded = Schema.decodeUnknownSync(BinaryLocator)(variant)
      expect(decoded.type).toBe(variant.type)
    }
  })

  test("rejects an unknown locator type", () => {
    expect(() => Schema.decodeUnknownSync(BinaryLocator)({ type: "ftp", path: "/x" })).toThrow()
  })
})

describe("BinaryMetadata", () => {
  const metadata = {
    mime: "application/pdf",
    filename: "spec.pdf",
    byteLength: 4096,
    checksum: { algorithm: "sha256", value: sha },
    provenance: { source: "user", trust: "untrusted" },
    locator: { type: "scoped-handle", handle: "hnd_123" },
  } as const

  test("decodes a full metadata record", () => {
    const decoded = Schema.decodeUnknownSync(BinaryMetadata)(metadata)
    expect(decoded.mime).toBe("application/pdf")
    expect(decoded.locator.type).toBe("scoped-handle")
  })

  test("survives a JSON round trip byte-for-byte in structure", () => {
    const json = Schema.encodeSync(BinaryMetadataJson)(metadata)
    const back = Schema.decodeUnknownSync(BinaryMetadataJson)(json)
    expect(back).toEqual(Schema.decodeUnknownSync(BinaryMetadata)(metadata))
  })

  test("rejects a malformed checksum", () => {
    expect(() =>
      Schema.decodeUnknownSync(BinaryMetadata)({ ...metadata, checksum: { algorithm: "sha256", value: "zz" } }),
    ).toThrow()
  })

  test("rejects a negative byteLength", () => {
    expect(() => Schema.decodeUnknownSync(BinaryMetadata)({ ...metadata, byteLength: -1 })).toThrow()
  })
})
