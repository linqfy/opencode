import type { Message } from './types'

export function groupMessagesByApiRound(messages: Message[]): Message[][] {
  const rounds: Message[][] = []
  let currentRound: Message[] = []

  for (const msg of messages) {
    currentRound.push(msg)
    if (msg.role === 'assistant' && !msg.tool_calls) { // rough approximation
      rounds.push(currentRound)
      currentRound = []
    }
  }

  if (currentRound.length > 0) {
    rounds.push(currentRound)
  }

  return rounds
}
