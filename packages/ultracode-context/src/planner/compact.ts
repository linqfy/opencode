import { microCompact } from "./microCompact"
import { totalTokens } from "./threshold"
import type {
  ArtifactPreviewFn,
  CompactionConfig,
  CompactionDeps,
  CompactionResult,
  PlannerMessage,
  PlannerPart,
} from "./types"

// Stage 1: remove duplicate text blocks within each message.
export const dedupeIdenticalBlocks = (messages: readonly PlannerMessage[]): readonly PlannerMessage[] =>
  messages.map((message) => {
    const seen = new Set<string>()
    const parts = message.parts.filter((part) => {
      if (part.kind !== "text") return true
      if (seen.has(part.text)) return false
      seen.add(part.text)
      return true
    })
    return parts.length === message.parts.length ? message : { ...message, parts }
  })

// Stage 2: replace oversized tool results with artifact previews (injected seam).
export const replaceOversizedWithPreviews = (
  messages: readonly PlannerMessage[],
  config: CompactionConfig,
  artifactPreview: ArtifactPreviewFn,
): readonly PlannerMessage[] =>
  messages.map((message) => ({
    ...message,
    parts: message.parts.map((part): PlannerPart => {
      if (part.kind === "tool_result" && part.tokens > config.oversizedResultTokens && !part.cleared) {
        return artifactPreview(part)
      }
      return part
    }),
  }))

// Recalculate each message's token total from its (possibly cleared/previewed)
// parts. Clearing/preview reduces part tokens; the message-level total must be
// recomputed or token accounting (tokensAfter) would not reflect the savings.
const retoken = (messages: readonly PlannerMessage[]): readonly PlannerMessage[] =>
  messages.map((message) => ({ ...message, tokens: message.parts.reduce((sum, part) => sum + part.tokens, 0) }))

// The staged controller (spec section 8): dedupe -> artifact-preview-replace ->
// prune/microcompact (protected) -> retoken -> checkpoint. The checkpoint
// narrative comes from the injected summarize seam; the engine fabricates
// nothing. Pure except for the (possibly async) summarize seam.
export const compactConversation = async (
  messages: readonly PlannerMessage[],
  config: CompactionConfig,
  deps: CompactionDeps,
): Promise<CompactionResult> => {
  const tokensBefore = totalTokens(messages)
  const deduped = dedupeIdenticalBlocks(messages)
  const previewed = replaceOversizedWithPreviews(deduped, config, deps.artifactPreview)
  const compacted = microCompact(previewed, config)
  const retokened = retoken(compacted.messages)
  const checkpoint = await deps.summarize(retokened)
  const tokensAfter = totalTokens(retokened)
  return {
    messages: retokened,
    checkpoint,
    tokensBefore,
    tokensAfter,
    clearedPartIds: compacted.clearedPartIds,
  }
}
