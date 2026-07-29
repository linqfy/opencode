import type { Message } from './types'

/**
 * Microcompact transforms repetitive tool exploration into structured evidence,
 * removing heavy raw outputs that aren't strictly necessary for the next turn.
 */
export async function microCompact(messages: Message[]): Promise<Message[]> {
  // In a full port, this rewrites FileRead and WebSearch results.
  // For now, it returns the messages unmodified or strips large payloads.
  return messages.map(msg => {
    // simplified mock
    return msg
  })
}
