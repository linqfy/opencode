export type Message = any
export type ToolUseContext = any
export type CompactionContext = {
  options: {
    mainLoopModel: string
    querySource?: string
  }
  agentId: string
  [key: string]: any
}
