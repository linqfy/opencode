import { Schema } from "effect"
import { MediaPart, ReasoningPart, TextPart, ToolCallPart, ToolResultPart } from "@opencode-ai/llm"

// Part types the OpenCode canonical model does not have (spec section 6).
// MediaPart already covers image/audio/video/document/file via mediaType;
// ReasoningPart covers opaque replay (encrypted) and summaries (text).

export const RefusalPart = Schema.Struct({
  type: Schema.Literal("refusal"),
  text: Schema.String,
}).annotate({ identifier: "Ultra.Content.Refusal" })
export type RefusalPart = typeof RefusalPart.Type

export const CitationPart = Schema.Struct({
  type: Schema.Literal("citation"),
  quotedText: Schema.String,
  url: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  startIndex: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  endIndex: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  trust: Schema.Literals(["privileged", "untrusted"]),
}).annotate({ identifier: "Ultra.Content.Citation" })
export type CitationPart = typeof CitationPart.Type

// A model-visible pointer to full bytes in the artifact store (spec section 8).
export const ArtifactRefPart = Schema.Struct({
  type: Schema.Literal("artifact-ref"),
  artifactId: Schema.String,
  mime: Schema.String,
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lineCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  sourceToolCallId: Schema.optional(Schema.String),
  preview: Schema.optional(Schema.String),
  truncationReason: Schema.optional(Schema.String),
}).annotate({ identifier: "Ultra.Content.ArtifactRef" })
export type ArtifactRefPart = typeof ArtifactRefPart.Type

export const UltraContentPart = Schema.Union([
  TextPart,
  MediaPart,
  ToolCallPart,
  ToolResultPart,
  ReasoningPart,
  RefusalPart,
  CitationPart,
  ArtifactRefPart,
])
export type UltraContentPart = typeof UltraContentPart.Type
export const UltraContentPartJson = Schema.fromJsonString(UltraContentPart)

// Addon metadata for tool results (spec section 6 "Every tool result preserves").
export const ToolResultMeta = Schema.Struct({
  toolCallId: Schema.String,
  status: Schema.Literals(["success", "error", "denied", "interrupted", "partial"]),
  truncationReason: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
  retryIdentity: Schema.optional(Schema.String),
  artifactIds: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Ultra.ToolResultMeta" })
export type ToolResultMeta = typeof ToolResultMeta.Type

// Provider-native reasoning state may only be replayed to a compatible route
// (spec section 6). Addons mark origin; evaluation lives in capability/compat.
export const ReasoningProvenance = Schema.Struct({
  provider: Schema.String,
  endpointFamily: Schema.String,
  model: Schema.String,
  protocolVersion: Schema.String,
}).annotate({ identifier: "Ultra.ReasoningProvenance" })
export type ReasoningProvenance = typeof ReasoningProvenance.Type
