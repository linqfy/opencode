import { Effect, Schema, Scope } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Tools } from "@opencode-ai/core/tool/tools"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "./catalog"
import type { McpTool } from "./index"

// Mirrors the V1 resource attachment policy so the V2 output stays model-visible-equivalent to V1.
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

export function registerMcpServerTools(
  serverName: string,
  tools: readonly McpTool[],
): Effect.Effect<void, Tool.RegistrationError, Scope.Scope | Tools.Service> {
  return Effect.gen(function* () {
    const registry = yield* Tools.Service
    const registered: Record<string, Tool.AnyTool> = {}
    for (const tool of tools) {
      const name = McpCatalog.toolName(serverName, tool.def.name)
      registered[name] = Tool.withPermission(mcpTool(serverName, name, tool), name)
    }
    yield* registry.register(registered)
  })
}

function mcpTool(serverName: string, name: string, tool: McpTool): Tool.AnyTool {
  return Tool.make({
    namespace: `mcp:${serverName}`,
    description: tool.def.description ?? "",
    input: Schema.Unknown,
    output: Schema.Unknown,
    execute: (args) => callTool(tool, args),
    toModelOutput: ({ output }) => modelOutput(output as CallToolResult),
  })
}

function callTool(tool: McpTool, args: unknown): Effect.Effect<CallToolResult, ToolFailure> {
  return Effect.tryPromise({
    try: () => McpCatalog.callTool(tool.client, tool.def.name, args, tool.timeout),
    catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
  })
}

function modelOutput(result: CallToolResult): ReadonlyArray<Tool.Content> {
  const parts: Tool.Content[] = []
  for (const item of result.content) {
    if (item.type === "text") parts.push({ type: "text", text: item.text })
    else if (item.type === "image") parts.push({ type: "file", data: item.data, mime: item.mimeType })
    else if (item.type === "resource") {
      const resource = item.resource
      if ("text" in resource && resource.text) parts.push({ type: "text", text: resource.text })
      else if ("blob" in resource && resource.blob) {
        const mime = resource.mimeType ?? "application/octet-stream"
        const size = base64Size(resource.blob)
        if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
          parts.push({
            type: "text",
            text: `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
          })
        } else if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
          parts.push({
            type: "text",
            text: `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
          })
        } else {
          parts.push({ type: "file", data: resource.blob, mime, name: resource.uri })
        }
      }
    }
  }
  return parts
}

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}
