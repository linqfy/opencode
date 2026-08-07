import type { Effect, Schema } from "effect"
import type { Hooks } from "./registration.js"

export type ToolSchema = Schema.Codec<unknown, unknown>

export interface ToolContext {
  readonly sessionID: string
  readonly agent: string
  readonly assistantMessageID: string
  readonly toolCallID: string
}

export interface ToolDefinition<Input extends ToolSchema = ToolSchema, Output extends ToolSchema = ToolSchema> {
  readonly namespace?: string
  readonly description: string
  readonly input: Input
  readonly output: Output
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    context: ToolContext,
  ) => Effect.Effect<Schema.Schema.Type<Output>>
}

export interface ToolDraft {
  register<Input extends ToolSchema, Output extends ToolSchema>(
    name: string,
    definition: ToolDefinition<Input, Output>,
  ): void
  remove(name: string): void
}

export type ToolHooks = Hooks<{
  transform: ToolDraft
}>
