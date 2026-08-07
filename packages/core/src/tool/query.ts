export * as ToolQuery from "./query"

const MAX_TOKENS = 12

const tokenize = (value: string): ReadonlyArray<string> =>
  value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []

export interface ToolQueryInput {
  readonly agentDescription?: string
  readonly agentName?: string
  readonly lastUserText?: string
}

export const buildToolQuery = (input: ToolQueryInput): string | undefined => {
  const text = input.lastUserText?.trim()
  if (text === undefined || text.length === 0) return undefined
  const keywords = tokenize(text)
  const userTerms = keywords.length > 0 ? keywords : [text]
  const agentTerms = [input.agentName, input.agentDescription].flatMap((value) =>
    value === undefined ? [] : tokenize(value),
  )
  return [...userTerms, ...agentTerms].slice(0, MAX_TOKENS).join(" ")
}
