import type { Planner } from "@ultracode/context"
import { Token } from "../util/token"
import type { SessionMessage } from "./message"

type Entry = { readonly seq: number; readonly message: SessionMessage.Message }

const tokens = (text: string): number => Token.estimate(text)

const TOOL_RESULT_MAX_CHARS = 2_000

const truncate = (value: string) =>
  value.length <= TOOL_RESULT_MAX_CHARS ? value : `${value.slice(0, TOOL_RESULT_MAX_CHARS)}\n[truncated]`

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
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [textPart(message.id, [message.text, ...files].filter(Boolean).join("\n"), { userAuthored: true })]
  }
  if (message.type === "synthetic") return [textPart(message.id, `[Synthetic context]: ${message.text}`)]
  if (message.type === "system") return [textPart(message.id, message.text)]
  if (message.type === "shell") return [textPart(message.id, `[Shell]: ${message.command}\n${truncate(message.output)}`)]
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
      const outputPaths = part.state.outputPaths ?? []
      const managed = outputPaths.length > 0 ? `\n[Managed output: ${outputPaths.join(", ")}]` : ""
      const text = `${output}${managed}`
      const result: Planner.PlannerPart = { id: `${part.id}-result`, kind: "tool_result", toolName: part.name, toolCallId: part.id, text, tokens: tokens(text) }
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

// Renders post-stage planner messages back into the serialized conversation the
// anchored-summary selection consumes, mirroring the read direction's labels.
// Messages in `skip` (previous compaction entries) are excluded from the
// conversation; their summary/recent are fed to the summarizer separately.
export const toPlannerText = (messages: readonly Planner.PlannerMessage[], skip?: ReadonlySet<string>): string[] => {
  const lines: string[] = []
  for (const message of messages) {
    if (skip?.has(message.id)) continue
    if (message.role === "user") {
      const text = message.parts.filter((part) => part.kind === "text").map((part) => part.text).join("\n")
      if (text) lines.push(message.parts.some((part) => part.userAuthored) ? `[User]: ${text}` : text)
    }
    if (message.role === "system") lines.push(`[System update]: ${message.parts.map((part) => part.text).join("\n")}`)
    if (message.role === "assistant") {
      for (const part of message.parts) {
        if (part.kind === "text") lines.push(`[Assistant]: ${part.text}`)
        if (part.kind === "reasoning" && part.text) lines.push(`[Assistant reasoning]: ${part.text}`)
        if (part.kind === "tool_use") lines.push(`[Assistant tool call]: ${part.toolName}(${part.text})`)
        if (part.kind === "tool_result")
          lines.push(
            part.activeFailure
              ? `[Tool error]: ${truncate(part.text)}`
              : `[Tool result]: ${part.cleared ? part.text : truncate(part.text)}`,
          )
      }
    }
  }
  return lines
}
