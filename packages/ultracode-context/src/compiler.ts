import { Effect } from "effect"

export const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export interface ContextPlan {
  agent: string
  model: string
  permission?: any[]
  environment?: string[]
  instructions?: string[]
  mcpInstructions?: string
  skills?: string
  format?: { type: string; schema?: any }
  agentInstructions?: string
}

export const compileSystemPrompt = (plan: ContextPlan): Effect.Effect<string[]> => {
  return Effect.sync(() => {
    const system: string[] = [
      ...(plan.environment ?? []),
      ...(plan.instructions ?? []),
      ...(plan.mcpInstructions ? [plan.mcpInstructions] : []),
      ...(plan.skills ? [plan.skills] : []),
      ...(plan.agentInstructions
        ? [
            "Additionally, you have the following specialized agent instructions for this task:",
            "<agent_instructions>",
            plan.agentInstructions,
            "</agent_instructions>",
          ]
        : []),
    ]

    if (plan.format?.type === "json_schema") {
      system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
    }

    return system
  })
}
