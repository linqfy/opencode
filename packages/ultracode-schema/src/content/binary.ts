import { Schema } from "effect"

// One of the six locations a binary payload can live (spec section 6).
export const BinaryLocator = Schema.Union([
  Schema.Struct({ type: Schema.Literal("inline-bytes"), bytes: Schema.Uint8Array }),
  Schema.Struct({ type: Schema.Literal("inline-base64"), base64: Schema.String }),
  Schema.Struct({ type: Schema.Literal("scoped-handle"), handle: Schema.String }),
  Schema.Struct({ type: Schema.Literal("uri"), uri: Schema.String }),
  Schema.Struct({ type: Schema.Literal("provider-file-id"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("artifact-id"), id: Schema.String }),
]).pipe(Schema.toTaggedUnion("type"))
export type BinaryLocator = typeof BinaryLocator.Type

export const BinaryChecksum = Schema.Struct({
  algorithm: Schema.Literal("sha256"),
  value: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
})
export type BinaryChecksum = typeof BinaryChecksum.Type

export const Provenance = Schema.Struct({
  source: Schema.Literals(["user", "tool", "retrieval", "web", "memory"]),
  trust: Schema.Literals(["privileged", "untrusted"]),
})
export type Provenance = typeof Provenance.Type

export const BinaryMetadata = Schema.Struct({
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  checksum: BinaryChecksum,
  provenance: Provenance,
  locator: BinaryLocator,
}).annotate({ identifier: "Ultra.BinaryMetadata" })
export type BinaryMetadata = typeof BinaryMetadata.Type

export const BinaryMetadataJson = Schema.fromJsonString(BinaryMetadata)
