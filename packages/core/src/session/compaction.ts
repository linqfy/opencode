export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@opencode-ai/llm"
import { Context, DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"
import { Planner } from "@ultracode/context"
import { toPlannerMessages, toPlannerText } from "./compaction-adapter"
import { checkpointPrompt, fallbackCheckpoint, parseCheckpoint } from "./compaction-summarize"
import { CompactionCheckpointStore } from "./compaction-checkpoint-store"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
  readonly snapshot: boolean
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
  readonly checkpointStore?: CompactionCheckpointStore.Interface
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
  readonly contextEpoch: number
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
      snapshot: current.snapshot ?? result.snapshot,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS, snapshot: false },
  )
}

// The admission line shared by the markdown buildPrompt and the typed-checkpoint
// seam so both prompt formats carry the "anchored summary" context.
const anchoredInstruction = (previousSummary?: string) =>
  previousSummary
    ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${previousSummary}\n</previous-summary>`
    : "Create a new anchored summary from the conversation history."

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [anchoredInstruction(input.previousSummary), SUMMARY_TEMPLATE, ...input.context].join("\n\n")

// The anchored-summary selection: splits the rendered conversation at the keep
// budget so the oldest content becomes `head` (fed to the summarizer) and the
// most recent content becomes `recent` (carried forward in the Compaction
// message). Operates on the post-stage render produced by the adapter.
const selectLines = (
  lines: readonly string[],
  tokens: number,
): { readonly head: string; readonly recent: string } | undefined => {
  if (lines.length === 0) return
  let total = 0
  let split = lines.length
  let splitPrefix = ""
  let splitSuffix = ""
  for (let index = lines.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(lines[index])
    if (next > tokens) {
      const remaining = Math.max(0, tokens - total) * 4
      if (remaining > 0) {
        splitPrefix = lines[index].slice(0, -remaining)
        splitSuffix = lines[index].slice(-remaining)
        split = index + 1
      }
      break
    }
    total = next
    split = index
  }
  return {
    head: [...lines.slice(0, split), splitPrefix].filter(Boolean).join("\n\n"),
    recent: [splitSuffix, ...lines.slice(split)].filter(Boolean).join("\n\n"),
  }
}

// Replaces an oversized tool result with a truncated preview that keeps the
// managed output path reference so the summarizer can still cite where the
// full output lives. The result is marked cleared so microCompact does not
// re-clear it.
const artifactPreview = (part: Planner.PlannerPart): Planner.PlannerPart => {
  const managed = part.text.match(/\[Managed output: [^\]]*\]$/)
  const body = managed ? part.text.slice(0, -managed[0].length).trimEnd() : part.text
  const text = `${truncate(body)}${managed ? `\n${managed[0]}` : ""}`
  return { ...part, text, tokens: Token.estimate(text), cleared: true }
}

type PipelineDependencies = {
  readonly llm: Dependencies["llm"]
  readonly config: readonly Config.Entry[]
}

// The injected summarize seam: runs the LLM stream over the post-stage
// conversation (selected head + previous compaction summary/recent) asking for
// the typed JSON checkpoint so the structured audit fields are populated in
// production, parses the output, and pins the recent tail's start message id so
// the checkpoint's `recentTailStartId` always references an existing message.
// The checkpoint's objective is the model-facing summary (the raw model text
// when the output cannot be parsed); compaction never fails on a parse error.
const summarize = (input: {
  readonly dependencies: PipelineDependencies
  readonly config: Settings
  readonly context: Context.Context<never>
  readonly previousSummary?: string
  readonly previousRecent?: string
  readonly model: Model
  readonly output: number
  readonly skip: ReadonlySet<string>
}) => async (messages: readonly Planner.PlannerMessage[]): Promise<Planner.CompactionCheckpoint> => {
  const tailStart = Planner.recentTailStart(messages, Planner.DEFAULT_COMPACTION_CONFIG.keepRecentTurns)
  const recentTailStartId = messages[tailStart]?.id
  const selected = selectLines(toPlannerText(messages, input.skip), input.config.tokens)
  const summaryPrompt = [
    anchoredInstruction(input.previousSummary),
    checkpointPrompt([input.previousRecent ?? "", selected?.head ?? ""].filter(Boolean)),
  ].join("\n\n")
  const summaryOutput = Math.min(input.output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
  const chunks: string[] = []
  let failed = false
  const effect = input.dependencies.llm
    .stream(
      LLM.request({
        model: input.model,
        messages: [Message.user(summaryPrompt)],
        tools: [],
        generation: { maxTokens: summaryOutput },
      }),
    )
    .pipe(
      Stream.runForEach((event) => {
        if (LLMEvent.is.providerError(event)) failed = true
        if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
        return Effect.void
      }),
      Effect.catchTag("LLM.Error", () => {
        failed = true
        return Effect.void
      }),
    )
  await Effect.runPromiseWith(input.context)(effect).catch(() => {
    failed = true
  })
  const text = failed ? "" : chunks.join("")
  const checkpoint = parseCheckpoint(text) ?? fallbackCheckpoint(text)
  return { ...checkpoint, recentTailStartId }
}

// The controller's single compaction entry: runs the staged planner over the
// history, renders the post-stage conversation back for anchored-summary
// selection, and returns the Compaction message payload plus the mapped cleared
// tool-part ids and the typed checkpoint. Event publishing stays in the caller.
export const CompactionPipeline = {
  run: Effect.fn("CompactionPipeline.run")(function* (dependencies: PipelineDependencies, input: Input) {
    const config = settings(dependencies.config)
    const compactionIds = new Set<string>(
      input.entries.filter((entry) => entry.message.type === "compaction").map((entry) => entry.message.id),
    )
    const plannerMessages = toPlannerMessages(input.entries)
    if (!plannerMessages.some((message) => !compactionIds.has(message.id))) return undefined
    const previous = input.entries.find((entry) => entry.message.type === "compaction")?.message
    const previousSummary = previous?.type === "compaction" ? previous.summary : undefined
    const previousRecent = previous?.type === "compaction" ? previous.recent : undefined
    const preflight = selectLines(toPlannerText(plannerMessages, compactionIds), config.tokens)
    if (preflight === undefined || (preflight.head.length === 0 && previousSummary === undefined)) return undefined
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const context = yield* Effect.context()
    const result = yield* Effect.promise(() =>
      Planner.compactConversation(plannerMessages, Planner.DEFAULT_COMPACTION_CONFIG, {
        artifactPreview,
        summarize: summarize({
          dependencies,
          config,
          context,
          previousSummary,
          previousRecent,
          model: input.model,
          output,
          skip: compactionIds,
        }),
      }),
    )
    const selected = selectLines(toPlannerText(result.messages, compactionIds), config.tokens)
    const summaryMessage = SessionMessage.Compaction.make({
      id: SessionMessage.ID.create(),
      type: "compaction",
      reason: "auto",
      summary: result.checkpoint.objective,
      recent: selected?.recent ?? "",
      time: { created: yield* DateTime.now },
    })
    const clearedPartIds = result.clearedPartIds.map((id) => id.replace(/-result$/, ""))
    // When the resolved model advertises provider-native content-block
    // deletion, carry the cleared part ids as cache-edit ops on the run result
    // so the next request can represent deletion without mutating history text
    // (which would bust the Anthropic prefix cache). The durable cleared state
    // above is identical either way; only the wire representation differs.
    return {
      summaryMessage,
      clearedPartIds,
      checkpoint: result.checkpoint,
      ...(input.model.compatibility?.cacheEdit === true
        ? { cacheEdit: { kind: "cache-edit", partIds: clearedPartIds } }
        : {}),
    }
  }),
}

type SnapshotMetadata =
  | { readonly preCompactionSnapshotSha: string }
  | { readonly snapshotLost: true }

// Best-effort persistence of the full pre-compaction provider-request context.
// Returns Started-event metadata: the artifact sha when the snapshot is stored,
// `snapshotLost` when storage is unavailable or fails, and undefined when the
// feature is disabled. Never fails the compaction flow.
const captureSnapshot = (
  dependencies: Dependencies,
  request: LLMRequest,
  enabled: boolean,
): Effect.Effect<SnapshotMetadata | undefined> => {
  if (!enabled) return Effect.succeed(undefined)
  if (!dependencies.checkpointStore) return Effect.succeed({ snapshotLost: true })
  return dependencies.checkpointStore.putSnapshot(request).pipe(
    Effect.match({
      onFailure: () => ({ snapshotLost: true }),
      onSuccess: (value) => ({ preCompactionSnapshotSha: value.sha }),
    }),
  )
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    // The pre-compaction snapshot is captured before any stage mutation runs,
    // and a failing or absent store must not fail compaction (CONTEXT.md
    // managed-output rule); loss is recorded on the Started event instead.
    const snapshotMetadata = yield* captureSnapshot(dependencies, input.request, config.snapshot)
    const result = yield* CompactionPipeline.run(dependencies, input)
    if (result === undefined || !result.summaryMessage.summary.trim()) return false
    const messageID = result.summaryMessage.id
    yield* dependencies.events.publish(
      SessionEvent.Compaction.Started,
      {
        sessionID: input.sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        reason: "auto",
      },
      snapshotMetadata === undefined ? undefined : { metadata: snapshotMetadata },
    )
    const previous = input.entries.find((entry) => entry.message.type === "compaction")?.message
    const parentCompactionSha =
      previous?.type === "compaction" && typeof previous.metadata?.checkpointSha === "string"
        ? previous.metadata.checkpointSha
        : undefined
    // Checkpoint persistence is best-effort: a missing or failing store must
    // not fail compaction (CONTEXT.md managed-output rule). Loss is recorded
    // explicitly on the Ended event instead.
    const stored = dependencies.checkpointStore
      ? yield* dependencies.checkpointStore
          .put({
            sessionID: input.sessionID,
            checkpoint: result.checkpoint,
            contextEpoch: input.contextEpoch,
            parentCompactionSha,
          })
          .pipe(
            Effect.match({
              onFailure: () => undefined,
              onSuccess: (value) => value,
            }),
          )
      : undefined
    const metadata = stored ? { checkpointSha: stored.sha } : { checkpointLost: true }
    yield* dependencies.events.publish(
      SessionEvent.Compaction.Ended,
      {
        sessionID: input.sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        reason: "auto",
        text: result.summaryMessage.summary,
        recent: result.summaryMessage.recent,
      },
      { metadata },
    )
    // Ride the cache-edit ops on the existing boolean contract so a future
    // consumer (RUN-05) can reach them without mutating history text; the
    // runner's truthiness check keeps working because the object is truthy.
    return result.cacheEdit === undefined ? true : { cacheEdit: result.cacheEdit }
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    if (
      estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }) <=
      context - Math.max(output, config.buffer)
    )
      return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
