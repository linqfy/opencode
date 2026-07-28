# Session ownership: legacy vs Session V2

Verified against baseline `a45c2b917e657e50881117e8c3f85f4bff06e47d`.

## Session V2 core (`packages/core/src/session`)

The durable session core. `input.ts`/`sql.ts` own the durable `session_input` inbox: `SessionV2.prompt(...)` admits one durable row before scheduling an advisory `SessionExecution.wake(sessionID)`. `run-coordinator.ts` owns process-local per-Session drains and coalesces wakeups. `execution.ts` is process-global and Session-ID based. `projector.ts`/`history.ts` project durable records into visible messages; historical prompts lazily synthesize promoted inbox records on exact retry. `event.ts` keeps EventV2 replay owner claims separate from Session execution ownership. `context-epoch.ts` owns Context Epoch persistence. One explicit `llm.stream(request)` call per provider turn is the rule; orchestration must not bridge through the legacy prompt loop.

## System Context (`packages/core/src/system-context`)

The System Context algebra, registry, and built-ins live here. Context Source producers stay with their observed domains; Session History selection and Context Epoch persistence remain Session-owned. This is the future implementation site of the spec's sole world-state service (spec §5).

## Legacy orchestration (`packages/opencode/src/session`)

Legacy session flows, including `compaction.ts`. No new UltraCode feature integrates here.

## UltraCode policy (spec §18 Stage 0, §19)

- New session features integrate at the Session V2 / core boundary, behind the future `ultracode-app-server` interfaces.
- A compatibility adapter may select legacy or V2 behavior per session during migration; a single session never runs both controllers.
- The legacy path is removed only after V2 parity is demonstrated and one release has passed.
