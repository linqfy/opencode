import type { Message, CompactionContext } from './types'
import { logForDebugging } from './adapters'

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

export function getEffectiveContextWindowSize(model: string): number {
  return 200_000 - 20_000 // Simplified window
}

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
}

export function isAutoCompactEnabled(): boolean {
  if (process.env.DISABLE_COMPACT || process.env.DISABLE_AUTO_COMPACT) {
    return false
  }
  return true
}

export async function shouldAutoCompact(
  tokenCount: number,
  model: string,
  querySource?: string
): Promise<boolean> {
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }

  if (!isAutoCompactEnabled()) {
    return false
  }

  const threshold = getAutoCompactThreshold(model)
  logForDebugging(`autocompact: tokens=${tokenCount} threshold=${threshold}`)

  return tokenCount >= threshold
}
