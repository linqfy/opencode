import { isPartProtected, recentTailStart } from "./protect"
import type { CompactionConfig, PlannerMessage } from "./types"
export const CLEARED_MESSAGE = "[Old tool result content cleared]"
const CLEARED_TOKENS = 4
const compactableResultIds = (messages: readonly PlannerMessage[], config: CompactionConfig): string[] => {
  const ids: string[] = []
  for (const message of messages) for (const part of message.parts) if (part.kind === "tool_result" && part.toolName && config.compactableTools.includes(part.toolName)) ids.push(part.id)
  return ids
}
export const microCompact = (messages: readonly PlannerMessage[], config: CompactionConfig): { messages: readonly PlannerMessage[]; clearedPartIds: readonly string[] } => {
  const tailStart = recentTailStart(messages, config.keepRecentTurns)
  const compactable = compactableResultIds(messages, config)
  const keepSet = new Set(compactable.slice(-Math.max(1, config.keepRecentToolResults)))
  const clearedPartIds: string[] = []
  const result = messages.map((message, messageIndex) => ({ ...message, parts: message.parts.map((part) => {
    if (part.kind !== "tool_result" || !compactable.includes(part.id) || keepSet.has(part.id) || messageIndex >= tailStart || isPartProtected(part) || part.cleared) return part
    clearedPartIds.push(part.id)
    return { ...part, text: CLEARED_MESSAGE, tokens: CLEARED_TOKENS, cleared: true }
  }) }))
  return { messages: result, clearedPartIds }
}
