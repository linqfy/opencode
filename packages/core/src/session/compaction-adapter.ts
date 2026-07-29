import type { Planner } from "@ultracode/context"
import { Token } from "../util/token"
import type { SessionMessage } from "./message"

type Entry = { readonly seq: number; readonly message: SessionMessage.Message }

const tokens = (text: string): number => Token.estimate(text)

const roleFor = (type: SessionMessage.Message["type"]): Planner.PlannerRole | undefined => {
  switch (type) {
    case "user":
    case "synthetic":
    case "shell":
    case "compaction":
      return "user"
    case "system":
      return "system"
    case "assistant":
      return "assistant"
    default:
      return undefined // agent-switched, model-switched -> dropped
  }
}

const textPart = (id: string, text: string, over: Partial<Planner.PlannerPart> = {}): Planner.PlannerPart => ({
  id,
  kind: "text",
  text,
  tokens: tokens(text),
  ...over,
})

const partsFor = (message: SessionMessage.Message): Planner.PlannerPart[] => {
  if (message.type === "user") return [textPart(message.id, message.text, { userAuthored: true })]
  if (message.type === "synthetic") return [textPart(message.id, message.text)]
  if (message.type === "system") return [textPart(message.id, message.text)]
  if (message.type === "shell") return [textPart(message.id, `Shell command: ${message.command}\n${message.output}`)]
  if (message.type === "compaction") return [textPart(message.id, `${message.summary}\n${message.recent}`)]
  if (message.type !== "assistant") return []
  return message.content.flatMap((part): Planner.PlannerPart[] => {
    if (part.type === "text") return [textPart(part.id, part.text)]
    if (part.type === "reasoning") return part.text ? [textPart(part.id, part.text, { kind: "reasoning" })] : []
    // part.type === "tool"
    const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
    const call: Planner.PlannerPart = { id: part.id, kind: "tool_use", toolName: part.name, toolCallId: part.id, text: input, tokens: tokens(input) }
    if (part.state.status === "completed") {
      const output = part.state.content.map((c) => (c.type === "text" ? c.text : `[Attached ${c.mime}]`)).join("\n")
      const result: Planner.PlannerPart = { id: `${part.id}-result`, kind: "tool_result", toolName: part.name, toolCallId: part.id, text: output, tokens: tokens(output) }
      return [call, result]
    }
    if (part.state.status === "error") {
      const output = part.state.error.message
      const result: Planner.PlannerPart = { id: `${part.id}-result`, kind: "tool_result", toolName: part.name, toolCallId: part.id, text: output, tokens: tokens(output), activeFailure: true }
      return [call, result]
    }
    return [call]
  })
}

// Converts runner history entries into the engine's PlannerMessage model,
// dropping non-conversation messages and tagging protected content.
export const toPlannerMessages = (entries: readonly Entry[]): Planner.PlannerMessage[] => {
  const result: Planner.PlannerMessage[] = []
  for (const entry of entries) {
    const role = roleFor(entry.message.type)
    if (role === undefined) continue
    const parts = partsFor(entry.message)
    if (parts.length === 0) continue
    result.push({ id: entry.message.id, role, parts, tokens: parts.reduce((sum, part) => sum + part.tokens, 0) })
  }
  return result
}
