# ultracode-context

Prompt compiler and (forthcoming) context planner for UltraCode (spec §7–§8).

## Compiler (`src/compiler/`)

`compileContext(plan: ContextPlan): CompiledPrompt` is PURE. It validates trust/channel placement (untrusted content may not occupy `immutable`/`session-stable` tiers), computes the budget (`input_budget = context_limit − output_reserve − fixed_safety`, `fixed_safety = max(endpoint allowance, 5% of context limit)`), throws rather than silently trimming when non-reducible input exceeds the budget, orders blocks deterministically by (stability rank, id), and SHA-256-fingerprints each block and the whole prompt so semantically identical plans produce byte-identical prefixes. `cacheBoundary` marks the first non-cache-stable block.

## Block assembly (`src/blocks.ts`)

`buildSystemPlan` assembles the standard privileged blocks (immutable kernel, environment, project instructions, MCP/skill manifests, optional structured-output instruction). This is a TEMPORARY bridge — the Stage 3b context planner replaces it with a budgeted, evidence-selected plan (checkpoint, recent tail, retrieved evidence, world-state diff).

The immutable kernel text lives in `src/compiler/kernel.ts`.
