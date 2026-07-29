export * as ToolDiscovery from "./discovery"

import { definition, type AnyTool } from "./tool"

export interface Result {
  readonly name: string
  readonly tool: AnyTool
  readonly score: number
}

const tokenize = (value: string): ReadonlyArray<string> =>
  value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []

export const search = (query: string, tools: ReadonlyMap<string, AnyTool>): ReadonlyArray<Result> => {
  const terms = tokenize(query)
  if (terms.length === 0) return []
  const documents = Array.from(tools, ([name, tool]) => {
    const toolDefinition = definition(name, tool)
    const tokens = tokenize([tool.namespace, name, toolDefinition.description, JSON.stringify(toolDefinition.inputSchema)].join(" "))
    return { name, tool, tokens }
  })
  const averageLength = documents.reduce((total, document) => total + document.tokens.length, 0) / documents.length
  const scores: Result[] = documents.map((document) => {
    const score = terms.reduce((total, term) => {
      const frequency = document.tokens.filter((token) => token === term).length
      if (frequency === 0) return total
      const matchingDocuments = documents.filter((candidate) => candidate.tokens.includes(term)).length
      const inverseDocumentFrequency = Math.log(1 + (documents.length - matchingDocuments + 0.5) / (matchingDocuments + 0.5))
      return total + (inverseDocumentFrequency * frequency * 2.2) / (frequency + 1.2 * (1 - 0.75 + (0.75 * document.tokens.length) / averageLength))
    }, 0)
    return { name: document.name, tool: document.tool, score }
  })
  return scores.filter((result) => result.score > 0).toSorted((left, right) => right.score - left.score || left.name.localeCompare(right.name))
}
