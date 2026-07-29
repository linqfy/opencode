import type { Message, CompactionContext } from './types'
import { shouldAutoCompact } from './autoCompact'
import { microCompact } from './microCompact'
import { logError } from './adapters'

export type CompactionResult = {
  summary: string
  newMessages: Message[]
}

export type RecompactionInfo = {
  isRecompactionInChain: boolean
  turnsSincePreviousCompact: number
  previousCompactTurnId?: string
  autoCompactThreshold: number
  querySource?: string
}

export async function compactConversation(
  messages: Message[],
  context: CompactionContext,
  isAutoCompact: boolean = false,
  recompactionInfo?: RecompactionInfo
): Promise<CompactionResult> {
  try {
    const compacted = await microCompact(messages)
    // Here we would run the LLM summarization.
    return {
      summary: "Compacted conversation summary",
      newMessages: compacted
    }
  } catch (error) {
    logError(error as Error)
    throw error
  }
}
