import { BEHAVIORAL_INVARIANTS, IDENTITY_BLOCK } from "./compiler/kernel"
import type { ContextBlock, ContextPlan } from "./compiler/types"

// Conservative token estimator (spec: use the model tokenizer where available,
// a conservative measured estimator otherwise). ~4 chars/token.
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

export const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export interface SystemPlanInput {
  environment: readonly string[]
  instructions: readonly string[]
  mcpInstructions?: string
  skills?: string
  agentInstructions?: string
  structuredOutput?: boolean
  modelContextLimit: number
  outputReserve: number
  userContentTokens: number
}

// Assembles the standard privileged system blocks. TEMPORARY bridge: the
// Stage 3b context planner replaces this with a budgeted, evidence-selected
// ContextPlan (checkpoint, recent tail, retrieved evidence, world-state diff).
export const buildSystemPlan = (input: SystemPlanInput): ContextPlan => {
  const blocks: ContextBlock[] = [
    {
      id: "0-identity",
      stability: "immutable",
      trust: "privileged",
      content: IDENTITY_BLOCK,
      estimatedTokens: estimateTokens(IDENTITY_BLOCK),
      provenance: "ultracode-kernel",
      inclusionReason: "identity",
    },
    {
      id: "1-behavioral-invariants",
      stability: "immutable",
      trust: "privileged",
      content: BEHAVIORAL_INVARIANTS,
      estimatedTokens: estimateTokens(BEHAVIORAL_INVARIANTS),
      provenance: "ultracode-kernel",
      inclusionReason: "behavioral-invariants",
    },
    ...input.environment.map((content, index) => ({
      id: `environment-${index}`,
      stability: "session-stable" as const,
      trust: "privileged" as const,
      content,
      estimatedTokens: estimateTokens(content),
      provenance: "environment",
      inclusionReason: "environment",
    })),
    ...input.instructions.map((content, index) => ({
      id: `instruction-${index}`,
      stability: "repository-stable" as const,
      trust: "privileged" as const,
      content,
      estimatedTokens: estimateTokens(content),
      provenance: "project-instructions",
      inclusionReason: "instructions",
    })),
    ...(input.mcpInstructions
      ? [{
          id: "mcp-manifests",
          stability: "registry-stable" as const,
          trust: "privileged" as const,
          content: input.mcpInstructions,
          estimatedTokens: estimateTokens(input.mcpInstructions),
          provenance: "mcp",
          inclusionReason: "mcp-manifests",
        }]
      : []),
    ...(input.skills
      ? [{
          id: "skill-manifests",
          stability: "registry-stable" as const,
          trust: "privileged" as const,
          content: input.skills,
          estimatedTokens: estimateTokens(input.skills),
          provenance: "skills",
          inclusionReason: "skill-manifests",
        }]
      : []),
    ...(input.agentInstructions
      ? [{
          id: "agent-instructions",
          stability: "session-stable" as const,
          trust: "privileged" as const,
          content: `<agent_instructions>\n${input.agentInstructions}\n</agent_instructions>`,
          estimatedTokens: estimateTokens(input.agentInstructions),
          provenance: "agent",
          inclusionReason: "agent-instructions",
        }]
      : []),
    ...(input.structuredOutput
      ? [{
          id: "structured-output",
          stability: "dynamic" as const,
          trust: "privileged" as const,
          content: STRUCTURED_OUTPUT_SYSTEM_PROMPT,
          estimatedTokens: estimateTokens(STRUCTURED_OUTPUT_SYSTEM_PROMPT),
          provenance: "runtime",
          inclusionReason: "structured-output",
        }]
      : []),
  ]

  return {
    blocks,
    modelContextLimit: input.modelContextLimit,
    outputReserve: input.outputReserve,
    userContentTokens: input.userContentTokens,
  }
}
