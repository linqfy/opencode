import type { CompactionConfig, PlannerMessage } from "./types"

// Claude's autocompact model (audit: autoCompact.ts getAutoCompactThreshold):
// threshold = effectiveContextWindow - bufferTokens, where the effective window
// already reserves output. Here outputReserve is subtracted explicitly.
export const compactThreshold = (config: CompactionConfig): number =>
  config.contextLimit - config.outputReserve - config.bufferTokens

export const shouldCompact = (tokens: number, config: CompactionConfig): boolean =>
  tokens >= compactThreshold(config)

export const totalTokens = (messages: readonly PlannerMessage[]): number =>
  messages.reduce((sum, message) => sum + message.tokens, 0)
