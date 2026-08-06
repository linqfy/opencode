# RUN-05: Capability Profiles at Runtime, Budget Spine, and Diagnostics Instrumentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `@ultracode/schema` capability profiles a runtime input to the V2 runner (cache policy, compaction buffer, output clamps, deterministic profile id), connect the DAG child-pool budget to the runner's supervising `Limits` as one numeric spine with `budget_exhausted` as a first-class terminal deliverable state, persist per-step usage diagnostics in core SQLite behind paged `/experimental/authority` endpoints, and commit the first machine-agnostic performance baselines.

**Architecture:** A pure `Profile` module in `packages/core` resolves a `CapabilityProfile` per (route, model) by seeding layers from the resolved llm `Model` (route family + default limits), applies `profileCachePolicy` (new in `@ultracode/schema`) to the request, and clamps generation/compaction from `profile.outputTokens`. The scheduler derives each child's supervise `Limits.maxTokens` solely from the durable DAG reservation, records the runner's actual token spend back into the sidecar child-pool (`useChildBudget` on the root + child reclaim), and promotes `budget_exhausted` to a first-class terminal task/deliverable state in both the Rust sidecar and the TS types. Per-step usage (`SessionEvent.Step.Ended` tokens + profile id) is written to a new core SQLite `step_usage` projection and served paged by the existing `authority` HttpApi group. A scripted bun benchmark emits `perf/baselines.json` (startup, session-open TTFT on a recorded cassette, idle RSS, sidecar spawn) — record-only, no machine-dependent thresholds.

**Tech Stack:** Effect-TS, `@ultracode/schema` (Effect Schema), Drizzle/SQLite (core projections), Bun, Rust (sidecar terminal-state addition), http-recorder cassettes, HttpApi (`effect/unstable/httpapi`).

**Audit basis:** §18-A1.4 (capability profiles at runtime), §18-A1.5 (budget spine), §20.8 + R9 (spend dashboards, cache-hit rate), §11 + §23.4 (committed baseline numbers), §6-T7 (usage loop closure), TODO.md Stage 7 "Persist and serve prompt/context/token/cache/provider compatibility diagnostics".

## Global Constraints

All constraints in `TODO/README.md` §2 apply verbatim. In addition:

- The journal and its projections remain single-owner (one-owner rule): step usage is session data, so its projection lands in **core SQLite** next to `SessionTable`, NOT the sidecar — the sidecar does not own session data until RUN-13/A2 collapses the session journal. Document this deviation (§18-A1.4 wording "serve via the Stage-7 diagnostics APIs"; the audit's "into the sidecar projections" wording for R9 applies post-A2).
- Dependency rule (README §2.7): adding `@ultracode/schema` as a dependency of `packages/core` is legal (Schema → Core). Do NOT import `@ultracode/schema` from `crates/ultracode-events` or from `packages/ultracode-agents`.
- Rust changes must pass `cargo test -p ultracode-events` and `cargo clippy -p ultracode-events -- -D warnings` from repo root (Rust exempt from the package-dir test rule).
- Sidecar wire-format additions only: `budget_exhausted` joins the existing terminal task-state set; no envelope changes, no new JSON-RPC methods.
- Never edit `packages/client/src/generated*` by hand. After changing the `authority` HttpApi group (Task 4), run `bun run generate` from `packages/client` and verify `git diff --stat` shows only generated output.
- No machine-dependent performance thresholds anywhere. Baseline harness is record-only; its test asserts schema shape only (per `packages/app/e2e/performance/AGENTS.md` items 11–12).
- Branch: `capability-diagnostics`.

## Orchestrator Brief

### Context Files (read in full before dispatching Task 1)

1. `packages/ultracode-schema/src/capability/profile.ts` (full) — `CapabilityProfile`, `CONSERVATIVE_PROFILE`, `narrowProfile`, `seedProfile`, `resolveProfile`, `ProfileLayer`. This is the contract Task 1 pins and Task 2 consumes.
2. `packages/ultracode-schema/src/capability/{index,compat}.ts` — module shape and export barrel.
3. `packages/ultracode-schema/test/profile.test.ts` — existing test style and what is already pinned.
4. `packages/core/src/session/runner/{model,index,llm}.ts` (full) — model resolution (route id/provider/id/defaults), `Limits { maxTokens, maxTurns }`, `runTurnAttempt` (`agent` at ~190, `model` at ~207, `LLM.request` at ~213, `compactIfNeeded` at ~224, `Step.Ended` at ~338), `RunResult.status` union.
5. `packages/core/src/session/compaction.ts` — `DEFAULT_BUFFER`, `settings`, `Input`, `compactIfNeeded` threshold.
6. `packages/core/src/session/execution.ts` + `execution/local.ts` — `supervise`, `SupervisionInput`, `TerminalRunResult` (status already includes `budget_exhausted`).
7. `packages/opencode/src/agent/scheduler.ts` — `executionCap = Math.min(childCap, durable.budget)` (~432), `finalize` (~296–369, `commitDeliverable`, `reclaimChildBudget` at ~333), `terminalTaskState` (~616), `terminalResult` (~622).
8. `packages/opencode/src/agent/scheduler-service.ts` — supervise pass-through (~267–289), server layer assembly (`SchedulerService.node`).
9. `packages/ultracode-agents/src/{budget,scheduler,graph,types,events-client}.ts` — `createBudget` 60/30/10, `useChildBudget`/`reclaimChildBudget`, `transitionTaskState`, `TaskState`, `DeliverableInput.status`, `TaskRecord` (has `budget_used`/`budget_reclaimed`).
10. `crates/ultracode-events/src/rpc.rs` — TaskStateChanged transition table (~1052–1062 and ~1378–1390), `TaskBudgetUsed`/`TaskBudgetReclaimed` terminal gates (~1083–1118), deliverable terminal checks (~1215–1235 and ~1460–1475), and the `#[test]` module harness (`dirs`, `SidecarState::open`, `req`, `handle_request`, `commit` closure, `spawned` helpers) around lines 1900–2105.
11. `crates/ultracode-events/src/projections.rs` — `terminal_details` (~168–175); `TaskRecord` SQL columns.
12. `packages/schema/src/session-event.ts` — `Step.Started`/`Step.Ended` shapes (`tokens: { input, output, reasoning, cache: { read, write } }`).
13. `packages/core/test/session-runner-recorded.test.ts` (full) — the recorded runner harness (layer stack, `HttpRecorder.http` replay, cassette `session-runner/openai-chat-streams-text`). Task 4 and Task 5 copy it.
14. `packages/opencode/test/agent/scheduler.test.ts` (full) — `FakeSidecar` + `createTaskSchedulerAdapter` driving pattern; **note line 652 asserts `task-budget-used` is NOT emitted — Task 3 intentionally flips this**.
15. `packages/opencode/test/server/httpapi-authority.test.ts` + `test/server/httpapi-layer.ts` — endpoint test style (`requestInDirectory`).
16. `packages/opencode/src/server/routes/instance/httpapi/groups/authority.ts` + `handlers/authority.ts` — endpoint declaration + handler style.
17. `packages/core/src/session/sql.ts` (table style), `packages/core/src/database/migration.ts` + `migration.gen.ts` + `packages/core/src/database/migration/20260510033149_session_usage.ts` (the migration-file pattern: `{ id, up(tx) }`), `packages/core/src/database/schema.gen.ts` (fresh-install `CREATE TABLE`).
18. `packages/desktop/src/main/startup-trace.ts` + `scripts/benchmarks/parse-startup-trace.ts` + `scripts/benchmarks/capture-environment.ts` + `perf/test-suite.md` — existing performance-culture artifacts.
19. `packages/app/e2e/performance/AGENTS.md` — "Do not enforce machine-dependent performance thresholds"; "assert scenario completion and metric collection only".
20. `packages/llm/src/schema/options.ts` (`CachePolicyObject`, `CacheHint`) + `packages/llm/src/cache-policy.ts` — the `ttlSeconds ≥ 3600 → Anthropic 1h` tier mapping the runner now feeds.
21. `packages/http-recorder/src/{cassette,schema}.ts` — `HttpRecorder.http(name, { directory })` replay layer (see `session-runner-recorded.test.ts` usage).
22. `packages/ultracode-events-client/src/index.ts` — `EventsClient.start(config)` + `client.ping()` (Task 5 sidecar-spawn metric).

### Baselines (record before Task 1)

```bash
cd packages/ultracode-schema && bun test 2>&1 | tail -5
cd packages/core && bun test test/session-runner-model.test.ts test/session-runner-recorded.test.ts 2>&1 | tail -5
cd packages/ultracode-agents && bun test 2>&1 | tail -5
cd packages/opencode && bun test test/agent/scheduler.test.ts test/server/httpapi-authority.test.ts 2>&1 | tail -5
cargo test -p ultracode-events 2>&1 | tail -5
test -f packages/core/test/fixtures/recordings/session-runner/openai-chat-streams-text.json && echo "cassette ok"
ls target/debug/sidecar 2>&1
```

### Dispatch Order

Tasks 1 → 6 strictly sequential, one fresh subagent per task. Task 2 and Task 4 both modify `packages/core/src/session/runner/llm.ts` — never run them concurrently; Task 4 lands strictly after Task 2 merges.

### Definition of Done (verify each with a command you ran)

- [ ] `cd packages/ultracode-schema && bun test test/cache-policy.test.ts test/profile-conformance.test.ts` — all green; `bun typecheck` green.
- [ ] `cd packages/core && bun test test/capability/profile.test.ts` green; `bun typecheck` green; grep the runner for `profileCachePolicy(profile)` and `buffer: profile.outputTokens` and `cache:` on the `LLM.request`.
- [ ] `cargo test -p ultracode-events budget_exhausted` green; `cargo clippy -p ultracode-events -- -D warnings` clean; `cd packages/ultracode-agents && bun test test/budget-exhausted.test.ts` green; `cd packages/opencode && bun test test/agent/scheduler-budget-spine.test.ts` green; `bun test test/agent/scheduler.test.ts` still green (updated assertion).
- [ ] `cd packages/core && bun test test/capability/diagnostics.test.ts test/session-runner-diagnostics.test.ts` green; `cd packages/opencode && bun test test/server/httpapi-authority-diagnostics.test.ts` green; `cd packages/client && bun run generate` then `git status --short packages/client/src/generated` shows no stray manual edits; `bun typecheck` in core and opencode.
- [ ] `bun run perf/baseline.ts` (repo root) writes `perf/baselines.json` with the four metrics as numeric `{ runs, p50, p95 }`; `cd packages/core && bun test test/perf/baselines.test.ts` green.
- [ ] `grep -c "Capability Profiles at Runtime" specs/v2/session.md` ≥ 1; `perf/baselines.md` exists; `TODO/README.md` §7 RUN-05 row names `Profile.resolve`/`SessionDiagnostics.Service`; `bun typecheck` passes in every touched TS package; `git status` clean; branch `capability-diagnostics`.

---

### Task 1: Profile cache-policy mapping + capability contract pinning

**Files:**
- Create: `packages/ultracode-schema/src/capability/cache.ts`
- Modify: `packages/ultracode-schema/src/capability/index.ts` (export `./cache`)
- Test: `packages/ultracode-schema/test/cache-policy.test.ts`
- Test: `packages/ultracode-schema/test/profile-conformance.test.ts`

**Interfaces:**
- Consumes: `CapabilityProfile` from `./profile` (existing).
- Produces:
  - `export interface CachePolicySpec { readonly tools?: boolean; readonly system?: boolean; readonly messages?: "latest-user-message" | "latest-assistant" | { readonly tail: number }; readonly ttlSeconds?: number }` — mirrors `@opencode-ai/llm` `CachePolicyObject` shape without importing it (schema must not depend on llm).
  - `export function profileCachePolicy(profile: CapabilityProfile): CachePolicySpec` — `caching.mode === "none"` → `{}`; otherwise `{ tools: true, system: true, messages: "latest-user-message", ...(profile.caching.ttlSeconds === undefined ? {} : { ttlSeconds: profile.caching.ttlSeconds }) }`. The `>= 3600 → 1h` tier decision stays in the llm package; this function only passes the profile's ttl through.

- [ ] **Step 1: Write the failing tests** — create `test/cache-policy.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { CONSERVATIVE_PROFILE, type CapabilityProfile } from "../src/capability/profile"
import { profileCachePolicy } from "../src/capability/cache"

const withCaching = (caching: CapabilityProfile["caching"]): CapabilityProfile => ({
  ...CONSERVATIVE_PROFILE,
  caching,
})

describe("profileCachePolicy", () => {
  test("a conservative profile (mode none) disables auto placement", () => {
    expect(profileCachePolicy(CONSERVATIVE_PROFILE)).toEqual({})
  })

  test("mode auto maps to tools + system + latest-user-message placement", () => {
    expect(profileCachePolicy(withCaching({ mode: "auto", breakpointLimit: 3 }))).toEqual({
      tools: true,
      system: true,
      messages: "latest-user-message",
    })
  })

  test("ephemeral with a ttl carries the ttl so the llm tier mapping can emit the 1h cache", () => {
    expect(profileCachePolicy(withCaching({ mode: "ephemeral", breakpointLimit: 3, ttlSeconds: 3600 }))).toEqual({
      tools: true,
      system: true,
      messages: "latest-user-message",
      ttlSeconds: 3600,
    })
  })

  test("persistent maps to auto placement plus the profile ttl", () => {
    expect(profileCachePolicy(withCaching({ mode: "persistent", breakpointLimit: 5, ttlSeconds: 3600 }))).toEqual({
      tools: true,
      system: true,
      messages: "latest-user-message",
      ttlSeconds: 3600,
    })
  })

  test("ephemeral without a ttl omits ttlSeconds", () => {
    expect(profileCachePolicy(withCaching({ mode: "ephemeral", breakpointLimit: 3 }))).toEqual({
      tools: true,
      system: true,
      messages: "latest-user-message",
    })
  })
})
```

- [ ] **Step 2: Write the contract pinning tests** — create `test/profile-conformance.test.ts`. These lock the semantics Task 2 depends on; they pass against current code (characterization), and must fail if the narrow-only merge contract drifts:

```ts
import { describe, expect, test } from "bun:test"
import { CONSERVATIVE_PROFILE, narrowProfile, resolveProfile, type CapabilityProfile } from "../src/capability/profile"

const anthropicBase: CapabilityProfile = {
  ...CONSERVATIVE_PROFILE,
  family: "anthropic-messages",
  contextTokens: 200_000,
  outputTokens: 64_000,
  caching: { mode: "ephemeral", breakpointLimit: 3, ttlSeconds: 3600 },
}

describe("capability profile contract (locked for runtime consumption)", () => {
  test("unknown and empty layers resolve to the conservative profile", () => {
    expect(resolveProfile([])).toEqual(CONSERVATIVE_PROFILE)
    expect(resolveProfile([{ input: { image: true } }])).toEqual(CONSERVATIVE_PROFILE)
  })

  test("caching strictness order none < auto < ephemeral < persistent: later layers only narrow", () => {
    expect(narrowProfile(anthropicBase, { caching: { mode: "auto" } }).caching.mode).toBe("auto")
    expect(narrowProfile(anthropicBase, { caching: { mode: "persistent" } }).caching.mode).toBe("ephemeral")
  })

  test("breakpointLimit and ttlSeconds take the minimum across layers", () => {
    const narrowed = narrowProfile(anthropicBase, { caching: { breakpointLimit: 1, ttlSeconds: 300 } })
    expect(narrowed.caching.breakpointLimit).toBe(1)
    expect(narrowed.caching.ttlSeconds).toBe(300)
  })

  test("tools.hosted is not narrowed by later layers", () => {
    const base = { ...anthropicBase, tools: { ...anthropicBase.tools, tools: true, hosted: ["web_search"] } }
    expect(narrowProfile(base, { tools: { hosted: [] } }).tools.hosted).toEqual(["web_search"])
  })

  test("a conservative profile carries no caching and no stateful continuation", () => {
    expect(CONSERVATIVE_PROFILE.caching.mode).toBe("none")
    expect(CONSERVATIVE_PROFILE.continuation.stateful).toBe(false)
  })
})
```

- [ ] **Step 3: Run both, watch them fail**

Run: `cd packages/ultracode-schema && bun test test/cache-policy.test.ts test/profile-conformance.test.ts`
Expected: FAIL — `Cannot find module "../src/capability/cache"`; the conformance cases error on the missing barrel export.

- [ ] **Step 4: Write minimal implementation** — `src/capability/cache.ts`:

```ts
import type { CapabilityProfile } from "./profile"

export interface CachePolicySpec {
  readonly tools?: boolean
  readonly system?: boolean
  readonly messages?: "latest-user-message" | "latest-assistant" | { readonly tail: number }
  readonly ttlSeconds?: number
}

const AUTO_PLACEMENT = { tools: true, system: true, messages: "latest-user-message" } as const

export function profileCachePolicy(profile: CapabilityProfile): CachePolicySpec {
  if (profile.caching.mode === "none") return {}
  return {
    ...AUTO_PLACEMENT,
    ...(profile.caching.ttlSeconds === undefined ? {} : { ttlSeconds: profile.caching.ttlSeconds }),
  }
}
```

Update `src/capability/index.ts` to `export * from "./cache"`.

- [ ] **Step 5: Run both, watch them pass** — same command as Step 3. Expected: 10 pass (5 + 5).
- [ ] **Step 6: Typecheck** — `cd packages/ultracode-schema && bun typecheck`
- [ ] **Step 7: Commit**

```bash
git add packages/ultracode-schema/src/capability/cache.ts packages/ultracode-schema/src/capability/index.ts packages/ultracode-schema/test/cache-policy.test.ts packages/ultracode-schema/test/profile-conformance.test.ts
git commit -m "feat(ultracode-schema): profile cache-policy mapping and capability contract pinning"
```

---

### Task 2: Runner consumes profiles per (route, model)

**Files:**
- Create: `packages/core/src/capability/profile.ts`
- Modify: `packages/core/package.json` (add `"@ultracode/schema": "workspace:*"` to `dependencies`)
- Modify: `packages/core/src/session/runner/llm.ts` (`runTurnAttempt`: resolve profile; `LLM.request` gains `cache` + clamped `generation`; `compactIfNeeded` gains `buffer`)
- Modify: `packages/core/src/session/compaction.ts` (`Input` gains `buffer?: number`; `compactIfNeeded` uses it)
- Test: `packages/core/test/capability/profile.test.ts`

**Interfaces:**
- Consumes: `CapabilityProfile`, `ProfileLayer`, `CONSERVATIVE_PROFILE`, `resolveProfile` from `@ultracode/schema/capability`; `profileCachePolicy`/`CachePolicySpec` (Task 1); `Model` from `@opencode-ai/llm`.
- Produces (all pure; no Effect service — a dependency-free deterministic function):
  - `export function profileId(model: Model): string` → `` `${model.route.id}:${model.provider}/${model.id}` ``.
  - `export function buildLayers(model: Model, options?: { readonly ttlSeconds?: number }): readonly ProfileLayer[]` → `[ { family: model.route.id, contextTokens?, outputTokens? }, { caching: { mode: "auto", breakpointLimit: 1, ttlSeconds? } } ]`.
  - `export interface ResolvedProfile { readonly profile: CapabilityProfile; readonly profileId: string; readonly layers: readonly ProfileLayer[]; readonly known: boolean }`.
  - `export function resolve(model: Model, options?: { readonly ttlSeconds?: number }): ResolvedProfile` — returns `CONSERVATIVE_PROFILE` with `known: false` when `model.route.defaults?.limits?.context === undefined` (unknown route has no capability signal), otherwise `known: true` and `resolveProfile(buildLayers(model, options))`. Determinism: `resolve` is a pure function of the resolved model; Task 4 persists the id per step. **`known: false` means the runner leaves the request completely untouched** (route defaults and config govern) — the conservative profile only feeds the recorded profile id, never overrides a configured generation/cache/buffer.

- [ ] **Step 1: Write the failing test** — create `packages/core/test/capability/profile.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Auth } from "@opencode-ai/llm/route"
import { CONSERVATIVE_PROFILE } from "@ultracode/schema/capability"
import { Profile } from "@opencode-ai/core/capability/profile"

const openaiModel = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.com/v1" }, auth: Auth.bearer("fixture") })
  .model({ id: "gpt-4o-mini" })
const anthropicModel = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.com" }, auth: Auth.header("x-api-key", "fixture") })
  .model({ id: "claude-3-5-sonnet" })

describe("Profile.resolve", () => {
  test("seeds the profile from the route family and default limits", () => {
    const model = OpenAIChat.route
      .with({
        endpoint: { baseURL: "https://api.openai.com/v1" },
        auth: Auth.bearer("fixture"),
        limits: { context: 128_000, output: 16_000 },
      })
      .model({ id: "gpt-4o" })
    const { profile, known } = Profile.resolve(model)
    expect(known).toBe(true)
    expect(profile.family).toBe("openai-chat")
    expect(profile.contextTokens).toBe(128_000)
    expect(profile.outputTokens).toBe(16_000)
    expect(profile.caching.mode).toBe("auto")
  })

  test("a long-running session class opts into a 1h cache ttl", () => {
    const model = AnthropicMessages.route
      .with({
        endpoint: { baseURL: "https://api.anthropic.com" },
        auth: Auth.header("x-api-key", "fixture"),
        limits: { context: 200_000, output: 64_000 },
      })
      .model({ id: "claude-3-5-sonnet" })
    const { profile } = Profile.resolve(model, { ttlSeconds: 3600 })
    expect(profile.caching.ttlSeconds).toBe(3600)
  })

  test("an unknown route without capability defaults falls back to the conservative profile and is not known", () => {
    const bare = OpenAIChat.route
      .with({ endpoint: { baseURL: "https://api.openai.com/v1" }, auth: Auth.none })
      .model({ id: "mystery" })
    const { profile, known } = Profile.resolve(bare)
    expect(known).toBe(false)
    expect(profile).toEqual(CONSERVATIVE_PROFILE)
  })

  test("profileId is deterministic and distinct per (route, model)", () => {
    expect(Profile.profileId(openaiModel)).toBe(Profile.profileId(openaiModel))
    expect(Profile.profileId(openaiModel)).not.toBe(Profile.profileId(anthropicModel))
    expect(Profile.profileId(openaiModel)).toBe(`openai-chat:${openaiModel.provider}/${openaiModel.id}`)
  })
})
```

- [ ] **Step 2: Run, watch it fail**

Run: `cd packages/core && bun test test/capability/profile.test.ts`
Expected: FAIL — `Cannot find module "@opencode-ai/core/capability/profile"`.

- [ ] **Step 3: Write minimal implementation** — `src/capability/profile.ts`:

```ts
export * as Profile from "./profile"

import { type Model } from "@opencode-ai/llm"
import { CONSERVATIVE_PROFILE, resolveProfile, type CapabilityProfile, type ProfileLayer } from "@ultracode/schema/capability"

export interface ResolvedProfile {
  readonly profile: CapabilityProfile
  readonly profileId: string
  readonly layers: readonly ProfileLayer[]
  readonly known: boolean
}

export const profileId = (model: Model) => `${model.route.id}:${model.provider}/${model.id}`

export const buildLayers = (model: Model, options: { readonly ttlSeconds?: number } = {}): readonly ProfileLayer[] => [
  {
    family: model.route.id,
    ...(model.route.defaults?.limits?.context === undefined
      ? {}
      : { contextTokens: model.route.defaults.limits.context }),
    ...(model.route.defaults?.limits?.output === undefined
      ? {}
      : { outputTokens: model.route.defaults.limits.output }),
  },
  {
    caching: {
      mode: "auto",
      breakpointLimit: 1,
      ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    },
  },
]

export const resolve = (model: Model, options: { readonly ttlSeconds?: number } = {}): ResolvedProfile => {
  const layers = buildLayers(model, options)
  const known = model.route.defaults?.limits?.context !== undefined
  if (!known) return { profile: CONSERVATIVE_PROFILE, profileId: profileId(model), layers, known }
  return { profile: resolveProfile(layers), profileId: profileId(model), layers, known }
}
```

Add `"@ultracode/schema": "workspace:*"` to `packages/core/package.json` `dependencies`.

- [ ] **Step 4: Wire the runner** — in `packages/core/src/session/runner/llm.ts`:

Add imports:
```ts
import { profileCachePolicy } from "@ultracode/schema/capability"
import { Profile } from "../../capability/profile"
```

Inside `runTurnAttempt`, immediately after `const model = yield* models.resolve(session)` (line ~207), resolve the profile deterministically (scheduler children are the long-running session class → 1h TTL):
```ts
const resolvedProfile = Profile.resolve(model, {
  ttlSeconds: agent.id.startsWith("scheduler_") ? 3600 : undefined,
})
const profile = resolvedProfile.profile
const known = resolvedProfile.known
```

Build the request with a profile-derived generation clamp and cache policy, but ONLY when the profile is `known` — an unknown route (conservative) leaves the request byte-identical to today (route defaults + config govern), which is what keeps recorded cassettes matching:
```ts
const reserveCap = known
  ? Math.min(profile.outputTokens, model.route.defaults?.generation?.maxTokens ?? Number.POSITIVE_INFINITY)
  : Number.POSITIVE_INFINITY
const generation =
  limits !== undefined
    ? { maxTokens: Math.min(reserveCap, limits.maxTokens - limits.tokens) }
    : known
      ? { maxTokens: reserveCap }
      : undefined
const request = LLM.request({
  model,
  ...(generation === undefined ? {} : { generation }),
  ...(known ? { cache: profileCachePolicy(profile) } : {}),
  providerOptions: { openai: { promptCacheKey } },
  system: [...],
  messages: [...toLLMMessages(context, model), ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])],
  tools: toolMaterialization?.definitions ?? [],
  toolChoice: isLastStep ? "none" : undefined,
})
```
The `Math.min(profile.outputTokens, routeDefaultGeneration)` term preserves a route-configured `generation.maxTokens` (e.g. recorded fixtures that pin `maxTokens: 20`) while still capping at the profile's output reserve. When `!known`, `reserveCap` is `Infinity`, `generation` reduces to exactly today's `limits ? { maxTokens: limits.maxTokens - limits.tokens } : undefined`, and no `cache` field is set (today's `undefined → "auto"` default applies unchanged).

In the `compactIfNeeded` call (~224), pass the profile-derived buffer only when known:
```ts
if (yield* compaction.compactIfNeeded({
  sessionID: session.id,
  entries,
  model,
  request,
  ...(known ? { buffer: profile.outputTokens } : {}),
}))
```

In `packages/core/src/session/compaction.ts`, extend `Input` and the threshold:
```ts
type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
  readonly buffer?: number
}
```
and in `compactIfNeeded` replace `config.buffer` with `input.buffer ?? config.buffer`:
```ts
if (
  estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }) <=
  context - Math.max(output, input.buffer ?? config.buffer)
)
  return false
```

- [ ] **Step 5: Run tests, watch them pass** — `cd packages/core && bun test test/capability/profile.test.ts test/session-runner-recorded.test.ts` — both green (the recorded runner now resolves a conservative profile for the fixture model and still passes its full assertion list).
- [ ] **Step 6: Typecheck** — `cd packages/core && bun typecheck`
- [ ] **Step 7: Commit**

```bash
git add packages/core/package.json packages/core/src/capability/profile.ts packages/core/src/session/runner/llm.ts packages/core/src/session/compaction.ts packages/core/test/capability/profile.test.ts
git commit -m "feat(core): resolve capability profiles per route-model in the runner"
```

---

### Task 3: Budget spine — single execution-cap source, spend reconciliation, `budget_exhausted` terminal state

**Files:**
- Modify: `packages/ultracode-agents/src/types.ts` (`TaskState` += `"budget_exhausted"`)
- Modify: `packages/ultracode-agents/src/graph.ts` (`transitionTaskState`: `running` → `budget_exhausted`)
- Modify: `packages/ultracode-agents/src/scheduler.ts` (`isTerminal` += `budget_exhausted`; `DeliverableInput.status` union += `"budget_exhausted"`; `validateSpawn` ignores terminal siblings)
- Modify: `packages/opencode/src/agent/scheduler.ts` (`deriveExecutionLimits`; `executionCap`; `finalize` records actual spend via `useChildBudget` on the root; `terminalTaskState` maps `budget_exhausted`)
- Modify: `crates/ultracode-events/src/rpc.rs` (transition table + terminal gates + deliverable terminal checks += `budget_exhausted`; new `#[test]`)
- Modify: `crates/ultracode-events/src/projections.rs` (`terminal_details` += `budget_exhausted`)
- Modify: `packages/opencode/test/agent/scheduler.test.ts` (line ~652 assertion flips: `task-budget-used` IS emitted now)
- Test: `packages/ultracode-agents/test/budget-exhausted.test.ts`
- Test: `packages/opencode/test/agent/scheduler-budget-spine.test.ts`

**Interfaces:**
- Consumes: `TaskRecord` (`budget`, `budget_used`, `budget_reclaimed`, `state`, `reserved_child_pool`), `ChildExecutionBoundary.supervise` (Task 1 of RUN-01 style), `createScheduler` client methods.
- Produces:
  - `TaskState` includes `"budget_exhausted"`; `transitionTaskState("running", "budget_exhausted")` → `{ ok: true, value: "budget_exhausted" }`.
  - `DeliverableInput.status` union = `"completed" | "failed" | "cancelled" | "budget_exhausted"`.
  - `export function deriveExecutionLimits(task: { readonly budget: number }): { readonly maxTokens: number }` → `{ maxTokens: task.budget }` — the DAG reservation is the single source for the runner's `Limits.maxTokens`.
  - Sidecar accepts `task-state-changed` `running → budget_exhausted`, treats `budget_exhausted` as terminal for budget use/reclaim/deliverable/cancellation gates, and surfaces it in `terminal_details`.

- [ ] **Step 1: Write the failing TS tests** — create `packages/ultracode-agents/test/budget-exhausted.test.ts`. Copy the `FakeEventClient` class verbatim from `packages/ultracode-agents/test/scheduler.test.ts` (lines 8–116), then add:

```ts
import { describe, expect, test } from "bun:test"
import { createScheduler, type TaskRecord } from "../src"
import { transitionTaskState } from "../src/graph"
// FakeEventClient copied from ./scheduler.test.ts

const task = (overrides: Partial<TaskRecord>): TaskRecord => ({
  root_id: "root",
  task_id: "child-a",
  parent_task_id: "root-task",
  depth: 1,
  state_changing: true,
  budget: 250,
  reserved_parent: 150,
  reserved_child_pool: 75,
  reserved_synthesis: 25,
  budget_used: 0,
  budget_reclaimed: 0,
  state: "pending",
  dependencies: [],
  ...overrides,
})

describe("budget_exhausted terminal state", () => {
  test("running -> budget_exhausted is a legal terminal transition", () => {
    expect(transitionTaskState("running", "budget_exhausted")).toEqual({ ok: true, value: "budget_exhausted" })
  })

  test("budget_exhausted is not a legal transition from pending", () => {
    expect(transitionTaskState("pending", "budget_exhausted")).toEqual({ ok: false, error: "invalid_transition" })
  })

  test("commitDeliverable accepts budget_exhausted as a terminal deliverable status", async () => {
    const client = new FakeEventClient()
    client.tasks.push(task({ state: "budget_exhausted" }))
    const scheduler = createScheduler(client)
    await scheduler.commitDeliverable({
      rootId: "root",
      taskId: "child-a",
      stateKey: "state-key",
      deliverableKey: "deliverable-key",
      status: "budget_exhausted",
      manifest: { summary: "child pool depleted", artifactIds: [], changedPaths: [] },
    })
    expect(client.deliverables[0]?.status).toBe("budget_exhausted")
  })

  test("validateSpawn ignores terminal children and budgets against the parent's recorded spend", async () => {
    const client = new FakeEventClient()
    client.tasks.push(
      task({ task_id: "root-task", depth: 0, parent_task_id: null, state_changing: false, budget: 1000, reserved_parent: 600, reserved_child_pool: 300, reserved_synthesis: 100, state: "running" }),
      task({ task_id: "child-a", budget: 250, budget_used: 0, budget_reclaimed: 150, state: "budget_exhausted" }),
    )
    const scheduler = createScheduler(client)
    await expect(
      scheduler.spawn({
        key: "spawn-child-b",
        task: {
          rootId: "root",
          taskId: "child-b",
          parentId: "root-task",
          depth: 1,
          stateChanging: true,
          dependencyIds: [],
          requestedMaxTokens: 150,
          requestedMaxTimeMs: 1000,
          forkMode: "none",
          selectedEvidenceArtifactIds: [],
          toolIds: [],
          expectedDeliverable: { name: "task-result", requiredFields: ["summary"] },
        },
        budget: { total: 150, fixedCosts: 0 },
      }),
    ).resolves.toEqual({ rootId: "root", taskId: "child-b" })
  })
})
```

Numbers for the last test: parent `reserved_child_pool` 300, parent `budget_used` 100 (recorded actual spend), terminal child-a `budget` 250 with `budget_reclaimed` 150. Old logic counts child-a at `250 − 150 = 100` plus 150 requested = 250 > 300 − 100 = 200 → fails. Fixed logic skips terminal child-a → 150 ≤ 200 → passes.

- [ ] **Step 2: Run, watch them fail**

Run: `cd packages/ultracode-agents && bun test test/budget-exhausted.test.ts`
Expected: FAIL — `running -> budget_exhausted` transition rejected; `commitDeliverable` rejects `budget_exhausted`; sibling spawn rejected.

- [ ] **Step 3: Write minimal TS implementation**

`packages/ultracode-agents/src/types.ts`:
```ts
export type TaskState = "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "budget_exhausted"
```

`packages/ultracode-agents/src/graph.ts` — extend the legal running set:
```ts
(from === "running" && (to === "completed" || to === "failed" || to === "cancelled" || to === "budget_exhausted"))
```

`packages/ultracode-agents/src/scheduler.ts`:
- `DeliverableInput.status`: `"completed" | "failed" | "cancelled" | "budget_exhausted"`.
- `isTerminal`: `state === "completed" || state === "failed" || state === "cancelled" || state === "budget_exhausted"`.
- `validateSpawn` childBudget loop — skip terminal siblings (their reservation is released; their actual spend is in `parent.budget_used`):
```ts
const childBudget = tasks
  .filter((task) => task.parent_task_id === input.task.parentId && !isTerminal(task.state as TaskState))
  .reduce((total, task) => total + task.budget, input.budget.total)
```

- [ ] **Step 4: Write the failing Rust test** — append to the `#[cfg(test)] mod` in `crates/ultracode-events/src/rpc.rs`, modeled on `child_pool_capacity_is_reserved_at_spawn_and_reclaimed_only_after_terminal_state` (line 2019):

```rust
#[test]
fn budget_exhausted_is_terminal_and_allows_reclaim_and_deliverable() {
    let (journal, db, blobs) = dirs("task-budget-exhausted-terminal");
    let mut state = SidecarState::open(&journal, &db, &blobs, "ses_1").unwrap();
    let commit = |state: &mut SidecarState, key: &str, kind: Value| {
        handle_request(
            state,
            &req(1, "propose_commit", json!({ "key": key, "kind": kind })),
        )
    };
    assert!(commit(&mut state, "root", json!({ "kind": "task-spawned", "data": {
        "root_id": "root", "task_id": "root-task", "parent_task_id": null, "depth": 0,
        "state_changing": false, "dependencies": [], "budget": 100, "workspace_directory": "C:\\workspace"
    }})).error.is_none());
    assert!(commit(&mut state, "root-budget", json!({ "kind": "task-budget-reserved", "data": {
        "root_id": "root", "task_id": "root-task", "parent": 60, "child_pool": 30, "synthesis": 10
    }})).error.is_none());
    assert!(commit(&mut state, "child", json!({ "kind": "task-spawned", "data": {
        "root_id": "root", "task_id": "child-a", "parent_task_id": "root-task", "depth": 1,
        "state_changing": true, "dependencies": [], "budget": 20
    }})).error.is_none());
    assert!(commit(&mut state, "reserve-child", json!({ "kind": "task-budget-reserved", "data": {
        "root_id": "root", "task_id": "child-a", "parent": 12, "child_pool": 6, "synthesis": 2
    }})).error.is_none());
    assert!(commit(&mut state, "to-running", json!({ "kind": "task-state-changed", "data": {
        "root_id": "root", "task_id": "child-a", "state": "running", "reason": null
    }})).error.is_none());
    assert!(commit(&mut state, "to-budget-exhausted", json!({ "kind": "task-state-changed", "data": {
        "root_id": "root", "task_id": "child-a", "state": "budget_exhausted", "reason": "child_pool depleted"
    }})).error.is_none());
    assert!(commit(&mut state, "reclaim", json!({ "kind": "task-budget-reclaimed", "data": {
        "root_id": "root", "task_id": "child-a", "amount": 10, "target": "child-pool"
    }})).error.is_none());
    assert!(commit(&mut state, "deliverable", json!({ "kind": "task-deliverable-committed", "data": {
        "root_id": "root", "task_id": "child-a", "status": "budget_exhausted", "summary": "pool depleted",
        "artifact_ids": [], "changed_paths": [], "test_summary": null
    }})).error.is_none());
    assert!(commit(&mut state, "reclaim-after-terminal", json!({ "kind": "task-budget-used", "data": {
        "root_id": "root", "task_id": "child-a", "amount": 1, "target": "child-pool"
    }})).error.unwrap().contains("exceeded"));
    let _ = std::fs::remove_dir_all(journal.parent().unwrap());
}
```

- [ ] **Step 5: Run the Rust test, watch it fail**

Run: `cargo test -p ultracode-events budget_exhausted_is_terminal`
Expected: FAIL — `invalid task-state transition: running -> budget_exhausted`; deliverable rejected as `"terminal task required"` mismatch.

- [ ] **Step 6: Write the minimal Rust implementation** — in `crates/ultracode-events/src/rpc.rs`, extend every terminal/task-state match arm to include `"budget_exhausted"` (locations verified while reading Context File 10):
- TaskStateChanged journal validation (~1055–1057): `("running", "completed" | "failed" | "cancelled" | "budget_exhausted")`.
- The second TaskStateChanged validation (~1382–1384): same edit.
- `TaskBudgetUsed` gate (~1096): reject when `task.state` is `"completed" | "failed" | "cancelled" | "budget_exhausted"`.
- `TaskBudgetReclaimed` gate (~1113): require `"completed" | "failed" | "cancelled" | "budget_exhausted"`.
- `TaskCancellationRequested` gate (~1124): treat `budget_exhausted` as terminal.
- Deliverable terminal checks (~1225 and ~1467): include `"budget_exhausted"` in the required-terminal and status-match sets.

In `crates/ultracode-events/src/projections.rs` `terminal_details` (~173): `matches!(state.as_str(), "completed" | "failed" | "cancelled" | "budget_exhausted")`.

- [ ] **Step 7: Run the Rust test, watch it pass** — `cargo test -p ultracode-events budget_exhausted_is_terminal`; then the full suite `cargo test -p ultracode-events` and `cargo clippy -p ultracode-events -- -D warnings`.
- [ ] **Step 8: Wire the opencode scheduler** — `packages/opencode/src/agent/scheduler.ts`:

Add near the other helpers:
```ts
export const deriveExecutionLimits = (task: { readonly budget: number }) => ({ maxTokens: task.budget })
```

In `schedule`, replace the `executionCap` line (~432):
```ts
const executionCap = deriveExecutionLimits(durable).maxTokens
```
(This makes the child's supervise `Limits.maxTokens` the durable DAG reservation — the single numeric source; the request's `maxTokens` only gates the root spawn reserve via `childCap`.)

In `finalize`, after the `getTask` that reads `task.budget` (~331) and before the existing `reclaimChildBudget` (~333), record the runner's actual spend on the root so the sidecar's `budget_used` column becomes the single audit spine:
```ts
if (terminal.usage.tokens > 0)
  yield* Effect.promise(() =>
    input.scheduler.useChildBudget({
      key: `task:${state.rootId}:${state.taskId}:budget-used`,
      rootId: state.rootId,
      taskId: state.rootId,
      amount: terminal.usage.tokens,
    }),
  )
```
Keep the existing child-level `reclaimChildBudget({ ..., amount: task.budget - terminal.usage.tokens })` (per-child returned-reservation audit; `validateSpawn` now skips terminal children so no double counting).

In `terminalTaskState` (~616):
```ts
function terminalTaskState(status: SessionExecution.TerminalRunResult["status"]) {
  if (status === "completed") return "completed" as const
  if (status === "cancelled") return "cancelled" as const
  if (status === "budget_exhausted") return "budget_exhausted" as const
  return "failed" as const
}
```

- [ ] **Step 9: Write the failing adapter test** — create `packages/opencode/test/agent/scheduler-budget-spine.test.ts`. Copy the `FakeSidecar` class verbatim from `packages/opencode/test/agent/scheduler.test.ts` (lines 28–112), then:

```ts
import { describe, expect, test } from "bun:test"
import { createScheduler } from "@ultracode/agents"
import { Effect } from "effect"
import {
  createChildSessionAdapter,
  createTaskSchedulerAdapter,
  createWorktreeLeaseAdapter,
  deriveExecutionLimits,
} from "../../src/agent/scheduler"
// FakeSidecar copied from ./scheduler.test.ts

const worktree = () =>
  createWorktreeLeaseAdapter(
    { directory: "/parent" },
    {
      makeWorktreeInfo: () => Effect.succeed({ name: "child", branch: "opencode/child", directory: "/child" }),
      createFromInfo: () => Effect.void,
      create: () => Effect.die("unexpected"),
      list: () => Effect.succeed([]),
      remove: () => Effect.succeed(true),
      reset: () => Effect.succeed(true),
    },
    (_, resolve) => {
      resolve(Effect.void)
      return () => {}
    },
  )

const request = {
  brief: "work",
  description: "work",
  agent: { name: "build", model: { providerID: "test", modelID: "model" }, toolConstraints: [] },
  forkMode: "none" as const,
  budget: { maxTurns: 2, maxTokens: 100_000, maxTimeMs: 1_000 },
  background: false,
  parent: { rootId: "ignored", taskId: "ignored", sessionID: "ses_parent" as never, messageID: "msg_parent" as never },
}

describe("budget spine", () => {
  test("deriveExecutionLimits takes the DAG reservation as the single maxTokens source", () => {
    expect(deriveExecutionLimits({ budget: 500 })).toEqual({ maxTokens: 500 })
    expect(deriveExecutionLimits({ budget: 500 }).maxTokens).not.toBe(100_000)
  })

  test("supervise maxTokens equals the durable reservation and actual spend is recorded on the root", async () => {
    const sidecar = new FakeSidecar()
    let supervised: { maxTokens: number; maxTurns: number } | undefined
    const child = createChildSessionAdapter({
      session: { create: (input) => Effect.succeed({ id: input.id }), prompt: () => Effect.succeed({}) },
      execution: {
        supervise: (input) =>
          Effect.gen(function* () {
            supervised = { maxTokens: input.maxTokens, maxTurns: input.maxTurns }
            return {
              status: "budget_exhausted",
              usage: { tokens: 17, turns: 2, elapsedMs: 3 },
              artifactIds: [],
              changedPaths: [],
            }
          }),
        interrupt: () => Effect.void,
      },
    })
    const adapter = createTaskSchedulerAdapter({ scheduler: createScheduler(sidecar), worktree: worktree(), child })

    const handle = await Effect.runPromise(adapter.schedule(request))

    const childTask = sidecar.tasks.find((task) => task.task_id === handle.taskId)
    expect(childTask).toBeDefined()
    expect(supervised?.maxTokens).toBe(childTask?.budget)
    expect(supervised?.maxTokens).toBeLessThan(100_000)
    const used = sidecar.events.find((event) => event.kind.kind === "task-budget-used")
    expect(used?.kind.data).toEqual({
      root_id: handle.rootId,
      task_id: handle.rootId,
      amount: 17,
      target: "child-pool",
    })
    expect(sidecar.deliverables).toEqual([
      expect.objectContaining({ task_id: handle.taskId, status: "budget_exhausted" }),
    ])
  })
})
```

Notes for the implementer: `FakeSidecar` spawns the root with `reserved_child_pool: 10_000`, so `childCap = Math.min(100_000, 10_000 − 0) = 10_000` and `durable.budget = 10_000`. The assertions `maxTokens === childTask.budget` and `< 100_000` prove the DAG reservation (not the request cap) drove the runner limit.

- [ ] **Step 10: Update the flipped existing assertions** — in `packages/opencode/test/agent/scheduler.test.ts`, this run intentionally changes two assertions in "awaits foreground supervision and persists bounded evidence before releasing its worktree" (both pin the old "spend never recorded" gap):
  1. Line ~652, change:
```ts
expect(sidecar.events.map((event) => event.kind.kind)).not.toContain("task-budget-used")
```
to:
```ts
expect(sidecar.events.map((event) => event.kind.kind)).toContain("task-budget-used")
```
  2. Lines ~655–661, the `slice(-5)` tail now includes the new `task-budget-used` event emitted right before `task-budget-reclaimed`:
```ts
expect(sidecar.events.map((event) => event.kind.kind).slice(-5)).toEqual([
  "task-deliverable-committed",
  "task-budget-used",
  "task-budget-reclaimed",
  "mailbox-message-sent",
  "worktree-released",
])
```
(The test's supervise stub returns `usage.tokens: 17`, so `task-budget-used` carries `amount: 17` on the root; verify with `sidecar.events.find((e) => e.kind.kind === "task-budget-used")`.)

- [ ] **Step 11: Run the opencode tests, watch them pass** — `cd packages/opencode && bun test test/agent/scheduler-budget-spine.test.ts test/agent/scheduler.test.ts`
- [ ] **Step 12: Run the agents tests, watch them pass** — `cd packages/ultracode-agents && bun test test/budget-exhausted.test.ts test/budget.test.ts test/graph.test.ts test/scheduler.test.ts`
- [ ] **Step 13: Typecheck** — `cd packages/ultracode-agents && bun typecheck`; `cd packages/opencode && bun typecheck`
- [ ] **Step 14: Commit**

```bash
git add packages/ultracode-agents/src/types.ts packages/ultracode-agents/src/graph.ts packages/ultracode-agents/src/scheduler.ts packages/ultracode-agents/test/budget-exhausted.test.ts packages/opencode/src/agent/scheduler.ts packages/opencode/test/agent/scheduler-budget-spine.test.ts packages/opencode/test/agent/scheduler.test.ts crates/ultracode-events/src/rpc.rs crates/ultracode-events/src/projections.rs
git commit -m "feat(ultracode-agents): single-source execution caps and budget_exhausted terminal state"
```

---

### Task 4: Per-step usage diagnostics persistence + paged read APIs

**Files:**
- Create: `packages/core/src/capability/sql.ts` (`StepUsageTable`)
- Create: `packages/core/src/capability/diagnostics.ts` (`SessionDiagnostics` service: `cacheHitRate`, `record`, `listStepUsage`, node)
- Create: `packages/core/src/database/migration/20260806000000_add_step_usage.ts` (hand-written migration, following `20260510033149_session_usage.ts`)
- Modify: `packages/core/src/database/migration.gen.ts` (register the new migration)
- Modify: `packages/core/src/database/schema.gen.ts` (add `CREATE TABLE step_usage` for fresh installs)
- Modify: `packages/core/src/session/runner/llm.ts` (call `diagnostics.record` at `Step.Ended`; add `SessionDiagnostics.node` to deps)
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/authority.ts` (`stepUsage` endpoint)
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/authority.ts` (`stepUsage` handler)
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts` (provide `SessionDiagnostics.node`)
- Test: `packages/core/test/capability/diagnostics.test.ts`
- Test: `packages/core/test/session-runner-diagnostics.test.ts`
- Test: `packages/opencode/test/server/httpapi-authority-diagnostics.test.ts`

**Interfaces:**
- Consumes: `SessionEvent.Step.Ended` `tokens` shape (`{ input, output, reasoning, cache: { read, write } }`); `Profile.resolve` (Task 2); `Database.Service`; `EventV2` (existing Step.Ended publish site).
- Produces:
  - `export function cacheHitRate(usage: { readonly input: number; readonly cacheRead: number }): number` — `(input + cacheRead) === 0 ? 0 : cacheRead / (input + cacheRead)`.
  - `export interface StepUsageRow { readonly id: number; readonly sessionID: string; readonly assistantMessageID: string; readonly providerID: string; readonly modelID: string; readonly profileID: string; readonly input: number; readonly output: number; readonly reasoning: number; readonly cacheRead: number; readonly cacheWrite: number; readonly cacheHitRate: number; readonly createdAt: number }`
  - `export interface Interface { readonly record: (input: { sessionID: string; assistantMessageID: string; providerID: string; modelID: string; profileID: string; usage: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } }) => Effect.Effect<void>; readonly listStepUsage: (input: { sessionID: string; cursor?: number; limit?: number }) => Effect.Effect<{ rows: StepUsageRow[]; nextCursor: number | null }> }`
  - `SessionDiagnostics.Service` (`@opencode/v2/SessionDiagnostics`), `SessionDiagnostics.node` (global node over `Database.node`).
  - HttpApi: `GET /experimental/authority/sessions/:sessionId/diagnostics` (endpoint name `stepUsage`).

Storage decision: step usage is session-step data flowing through EventV2, which owns sessions today — so the projection is a **core SQLite** table beside `SessionTable`, and the read endpoint lives in the existing `authority` group (audit §20.8/R9 "spend dashboards backed by projections"). The sidecar move is RUN-13/A2 work; recorded as a Deviation.

- [ ] **Step 1: Write the failing core test** — create `packages/core/test/capability/diagnostics.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionDiagnostics } from "@opencode-ai/core/capability/diagnostics"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, SessionDiagnostics.node])),
)

describe("cacheHitRate", () => {
  test("cache hits dominate the served share of fresh input", () => {
    expect(SessionDiagnostics.cacheHitRate({ input: 1_000, cacheRead: 9_000 })).toBeCloseTo(0.9)
    expect(SessionDiagnostics.cacheHitRate({ input: 1_000, cacheRead: 0 })).toBe(0)
    expect(SessionDiagnostics.cacheHitRate({ input: 0, cacheRead: 0 })).toBe(0)
  })
})

describe("SessionDiagnostics", () => {
  it.effect("records a step row and pages over it by cursor", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionV2.ID.make("ses_diag"),
          project_id: ProjectV2.ID.global,
          slug: "diag",
          directory: "/project",
          title: "diag",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const diagnostics = yield* SessionDiagnostics.Service
      const usage = { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 50 } }
      yield* diagnostics.record({
        sessionID: "ses_diag",
        assistantMessageID: "msg_1",
        providerID: "openai",
        modelID: "gpt-4o-mini",
        profileID: "openai-chat:openai/gpt-4o-mini",
        usage,
      })
      yield* diagnostics.record({
        sessionID: "ses_diag",
        assistantMessageID: "msg_2",
        providerID: "openai",
        modelID: "gpt-4o-mini",
        profileID: "openai-chat:openai/gpt-4o-mini",
        usage,
      })
      const first = yield* diagnostics.listStepUsage({ sessionID: "ses_diag", limit: 1 })
      expect(first.rows).toHaveLength(1)
      expect(first.rows[0]?.cacheHitRate).toBeCloseTo(0.9)
      expect(first.nextCursor).toBe(first.rows[0]?.id ?? null)
      const second = yield* diagnostics.listStepUsage({ sessionID: "ses_diag", cursor: first.nextCursor ?? undefined })
      expect(second.rows).toHaveLength(1)
      expect(second.nextCursor).toBeNull()
    }),
  )
})
```
(`SessionDiagnostics.cacheHitRate` is module-level pure, so it is testable without the layer; the `it.effect` harness matches `session-runner-recorded.test.ts`.)

- [ ] **Step 2: Run, watch it fail**

Run: `cd packages/core && bun test test/capability/diagnostics.test.ts`
Expected: FAIL — module `@opencode-ai/core/capability/diagnostics` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`src/capability/sql.ts`:
```ts
import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"

export const StepUsageTable = sqliteTable(
  "step_usage",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    profile_id: text().notNull(),
    input_tokens: integer().notNull(),
    output_tokens: integer().notNull(),
    reasoning_tokens: integer().notNull(),
    cache_read_tokens: integer().notNull(),
    cache_write_tokens: integer().notNull(),
    cache_hit_rate: real().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [index("step_usage_session_idx").on(table.session_id)],
)
```

`src/capability/diagnostics.ts`:
```ts
export * as SessionDiagnostics from "./diagnostics"

import { and, desc, eq, lt } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"
import { StepUsageTable } from "./sql"

export const cacheHitRate = (usage: { readonly input: number; readonly cacheRead: number }) => {
  const total = usage.input + usage.cacheRead
  return total === 0 ? 0 : usage.cacheRead / total
}

export interface StepUsageRow {
  readonly id: number
  readonly sessionID: string
  readonly assistantMessageID: string
  readonly providerID: string
  readonly modelID: string
  readonly profileID: string
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cacheHitRate: number
  readonly createdAt: number
}

const row = (value: (typeof StepUsageTable)["$inferSelect"]): StepUsageRow => ({
  id: value.id,
  sessionID: value.session_id,
  assistantMessageID: value.assistant_message_id,
  providerID: value.provider_id,
  modelID: value.model_id,
  profileID: value.profile_id,
  input: value.input_tokens,
  output: value.output_tokens,
  reasoning: value.reasoning_tokens,
  cacheRead: value.cache_read_tokens,
  cacheWrite: value.cache_write_tokens,
  cacheHitRate: value.cache_hit_rate,
  createdAt: value.time_created,
})

export interface Interface {
  readonly record: (input: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly providerID: string
    readonly modelID: string
    readonly profileID: string
    readonly usage: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cache: { readonly read: number; readonly write: number } }
  }) => Effect.Effect<void>
  readonly listStepUsage: (input: { readonly sessionID: string; readonly cursor?: number; readonly limit?: number }) => Effect.Effect<{ rows: StepUsageRow[]; nextCursor: number | null }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionDiagnostics") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return Service.of({
      record: (input) =>
        db
          .insert(StepUsageTable)
          .values({
            session_id: SessionSchema.ID.make(input.sessionID),
            assistant_message_id: input.assistantMessageID,
            provider_id: input.providerID,
            model_id: input.modelID,
            profile_id: input.profileID,
            input_tokens: input.usage.input,
            output_tokens: input.usage.output,
            reasoning_tokens: input.usage.reasoning,
            cache_read_tokens: input.usage.cache.read,
            cache_write_tokens: input.usage.cache.write,
            cache_hit_rate: cacheHitRate({ input: input.usage.input, cacheRead: input.usage.cache.read }),
          })
          .run()
          .pipe(Effect.asVoid),
      listStepUsage: (input) =>
        Effect.gen(function* () {
          const limit = Math.min(200, Math.max(1, input.limit ?? 100))
          // Fetch limit + 1 to learn whether another page exists.
          const values = yield* db
            .select()
            .from(StepUsageTable)
            .where(
              and(
                eq(StepUsageTable.session_id, SessionSchema.ID.make(input.sessionID)),
                input.cursor === undefined ? undefined : lt(StepUsageTable.id, input.cursor),
              ),
            )
            .orderBy(desc(StepUsageTable.id))
            .limit(limit + 1)
            .run()
          const hasMore = values.length > limit
          const rows = values.slice(0, limit).map(row)
          const nextCursor = hasMore ? rows[rows.length - 1]?.id ?? null : null
          return { rows, nextCursor }
        }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
```

Migration `src/database/migration/20260806000000_add_step_usage.ts` (hand-written, following the existing pattern):
```ts
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806000000_add_step_usage",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`step_usage\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`profile_id\` text NOT NULL,
          \`input_tokens\` integer NOT NULL,
          \`output_tokens\` integer NOT NULL,
          \`reasoning_tokens\` integer NOT NULL,
          \`cache_read_tokens\` integer NOT NULL,
          \`cache_write_tokens\` integer NOT NULL,
          \`cache_hit_rate\` real NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_step_usage_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`step_usage_session_idx\` ON \`step_usage\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration
```
Register it in `migration.gen.ts` (add `await import("./migration/20260806000000_add_step_usage")` to the `Promise.all`) and append the matching `CREATE TABLE step_usage ...` block to `schema.gen.ts` `up(tx)` so fresh installs get it too.

Wire the runner in `packages/core/src/session/runner/llm.ts`:
- Import: `import { SessionDiagnostics } from "../../capability/diagnostics"`.
- In the layer, add `const diagnostics = yield* SessionDiagnostics.Service`.
- At the `Step.Ended` publish site (~337–348), after `events.publish(SessionEvent.Step.Ended, {...})`, record:
```ts
yield* withPublication(
  diagnostics.record({
    sessionID: session.id,
    assistantMessageID: yield* publisher.startAssistant(),
    providerID: model.provider,
    modelID: model.id,
    profileID: resolvedProfile.profileId,
    usage: stepSettlement.tokens,
  }),
)
```
- Add `SessionDiagnostics.node` to the runner's `node` deps list (~467–484).

- [ ] **Step 4: Run the core test, watch it pass** — `cd packages/core && bun test test/capability/diagnostics.test.ts`
- [ ] **Step 5: Write the failing runner-integration test** — create `packages/core/test/session-runner-diagnostics.test.ts`. Copy the entire layer-stack + `it` harness from `session-runner-recorded.test.ts` (lines 1–140), add `SessionDiagnostics.node` to the `AppNodeBuilder.build` group AND to the replacements, and assert:

```ts
describe("SessionRunnerLLM diagnostics", () => {
  it.effect("records one step_usage row with the resolved profile id", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      // same Project + Session seed as session-runner-recorded.test.ts
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Say hello in one short sentence." }),
        resume: false,
      })
      yield* session.resume(sessionID)

      const rows = yield* db.select().from(StepUsageTable).where(eq(StepUsageTable.session_id, sessionID)).run()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.profile_id).toBe(Profile.profileId(model))
      expect(rows[0]?.input_tokens).toBeGreaterThan(0)
    }),
  )
})
```
(The recorded `model` is the `OpenAIChat.route.with(...).model({ id: "gpt-4o-mini" })` fixture from the copied harness; `Profile.profileId(model)` is deterministic. Import `Profile` from `@opencode-ai/core/capability/profile` and `StepUsageTable` from `@opencode-ai/core/capability/sql`.)

- [ ] **Step 6: Run, watch it fail** — `cd packages/core && bun test test/session-runner-diagnostics.test.ts` — FAIL: `step_usage` table has no rows (record call not yet wired) or table missing (migration not applied in the test DB).
- [ ] **Step 7: Run, watch it pass** — same command. (Implementer must ensure `Database.node` applies migrations in tests; if `session-runner-recorded.test.ts` already relies on that, it does.)
- [ ] **Step 8: Add the paged read endpoint** — `groups/authority.ts`, inside the existing group `.add(...)`, add before the closing `)`:
```ts
HttpApiEndpoint.get("stepUsage", `${root}/sessions/:sessionId/diagnostics`, {
  params: { sessionId: Schema.String },
  query: AuthorityPageQuery,
  success: Schema.Unknown,
}),
```
`handlers/authority.ts` — add a handler:
```ts
.handle("stepUsage", (ctx: { params: { sessionId: string }; query: typeof AuthorityPageQuery.Type }) =>
  Effect.gen(function* () {
    const diagnostics = yield* SessionDiagnostics.Service
    const result = yield* diagnostics.listStepUsage({
      sessionID: ctx.params.sessionId,
      cursor: ctx.query.cursor === undefined ? undefined : Number(ctx.query.cursor),
      limit: page(ctx.query),
    })
    return { rows: result.rows, next_cursor: result.nextCursor }
  }),
)
```
Import `SessionDiagnostics` from `@opencode-ai/core/capability/diagnostics`. Add `SessionDiagnostics.node` to the assembly in `packages/opencode/src/server/routes/instance/httpapi/server.ts` alongside `Database.node` (line ~219).

- [ ] **Step 9: Write the failing endpoint test** — create `packages/opencode/test/server/httpapi-authority-diagnostics.test.ts`:
```ts
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

describe("authority diagnostics HttpApi", () => {
  it.live("returns an empty paged page for a session without recorded diagnostics", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const response = yield* requestInDirectory(
        "/experimental/authority/sessions/ses_missing/diagnostics?limit=10",
        directory,
      )
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ rows: [], next_cursor: null })
    }),
  )
})
```
- [ ] **Step 10: Run, watch it fail** — `cd packages/opencode && bun test test/server/httpapi-authority-diagnostics.test.ts` — FAIL: 404/validation on the undeclared endpoint.
- [ ] **Step 11: Run, watch it pass** — same command.
- [ ] **Step 12: Regenerate the client** — `cd packages/client && bun run generate`; verify `git status --short` under `packages/client/src/generated*` only.
- [ ] **Step 13: Typecheck** — `cd packages/core && bun typecheck`; `cd packages/opencode && bun typecheck`
- [ ] **Step 14: Commit**

```bash
git add packages/core/src/capability packages/core/src/session/runner/llm.ts packages/core/src/database/migration/20260806000000_add_step_usage.ts packages/core/src/database/migration.gen.ts packages/core/src/database/schema.gen.ts packages/core/test/capability/diagnostics.test.ts packages/core/test/session-runner-diagnostics.test.ts packages/opencode/src/server/routes/instance/httpapi/groups/authority.ts packages/opencode/src/server/routes/instance/httpapi/handlers/authority.ts packages/opencode/src/server/routes/instance/httpapi/server.ts packages/opencode/test/server/httpapi-authority-diagnostics.test.ts packages/client/src/generated packages/client/src/generated-effect
git commit -m "feat(core): per-step usage diagnostics persistence and paged authority reads"
```

---

### Task 5: Performance baseline harness (record-only)

**Files:**
- Create: `perf/baseline.ts` (bun script, run from repo root)
- Create: `perf/baselines.json` (generated output, committed)
- Test: `packages/core/test/perf/baselines.test.ts` (schema sanity only)

**Interfaces:**
- Consumes: `@ultracode/events-client` `EventsClient.start` + `ping`; the recorded runner layer stack from `packages/core/test/session-runner-recorded.test.ts`; `HttpRecorder.http`; `SessionDiagnostics` (Task 4, optional); `scripts/benchmarks/capture-environment.ts` env shape.
- Produces: `perf/baselines.json` with schema:
```json
{
  "captured_at": "<ISO>",
  "reference_machine": "docs/benchmarks/environment.json",
  "startup_ms": { "runs": 3, "p50": 0, "p95": 0 },
  "session_open_ttft_ms": { "runs": 3, "p50": 0, "p95": 0 },
  "idle_memory_after_sessions_mb": { "runs": 3, "p50": 0, "p95": 0 },
  "sidecar_spawn_ms": { "runs": 3, "p50": 0, "p95": 0 }
}
```
No thresholds; p50/p95 computed over `runs` host samples. `sidecar_spawn_ms` requires the sidecar binary; the script fails with a build hint if absent (baselines are a deliberate host act).

- [ ] **Step 1: Write the failing sanity test first** — create `packages/core/test/perf/baselines.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const BASELINES = path.resolve(import.meta.dir, "../../../../perf/baselines.json")

const METRICS = ["startup_ms", "session_open_ttft_ms", "idle_memory_after_sessions_mb", "sidecar_spawn_ms"] as const

describe("perf/baselines.json schema", () => {
  test("committed baselines carry the four required numeric metrics", () => {
    const baselines = JSON.parse(readFileSync(BASELINES, "utf8")) as Record<string, unknown>
    expect(typeof baselines.captured_at).toBe("string")
    for (const metric of METRICS) {
      const value = baselines[metric]
      expect(value, metric).toMatchObject({ runs: expect.any(Number), p50: expect.any(Number), p95: expect.any(Number) })
      const p50 = (value as { p50: number }).p50
      expect(typeof p50).toBe("number")
      expect(p50).toBeGreaterThanOrEqual(0)
    }
  })
})
```
- [ ] **Step 2: Run, watch it fail** — `cd packages/core && bun test test/perf/baselines.test.ts` — FAIL: `perf/baselines.json` does not exist.
- [ ] **Step 3: Write the benchmark script** — `perf/baseline.ts` at repo root. Structure (happy path on top; helpers below):

```ts
#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { existsSync } from "node:fs"

const RUNS = Number(process.env.BASELINE_RUNS ?? "3")

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}
const percentile = (values: readonly number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!
}
const summarize = (values: readonly number[]) => ({ runs: values.length, p50: median(values), p95: percentile(values, 95) })

// 1) cold process -> interactive: spawn the CLI server and wait for the listening line
async function measureStartup(): Promise<number[]> {
  const samples: number[] = []
  for (let run = 0; run < RUNS; run++) {
    const started = Date.now()
    const child = spawn(
      "bun",
      ["--cwd", "packages/opencode", "--conditions=browser", "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0"],
      { stdio: ["ignore", "pipe", "inherit"] },
    )
    await new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! })
      lines.on("line", (line) => {
        if (line.includes("opencode server listening on http://")) resolve()
      })
      child.once("error", reject)
    })
    samples.push(Date.now() - started)
    child.kill("SIGTERM")
  }
  return samples
}
// 2) session-open TTFT on a recorded cassette (in-process runner, from session-runner-recorded.test.ts)
async function measureTTFT(): Promise<number[]> { /* copy the recorded-runner stack; see notes below */ }
// 3) idle RSS after N sessions, reusing measureTTFT's runner
async function measureIdleMemory(): Promise<number[]> { /* see notes below */ }
// 4) sidecar spawn -> ping via @ultracode/events-client
async function measureSidecarSpawn(): Promise<number[]> {
  const candidates = [
    process.env.ULTRACODE_EVENTS_SIDECAR_BIN,
    path.resolve("packages/opencode/target/debug", process.platform === "win32" ? "sidecar.exe" : "sidecar"),
    path.resolve("target/debug", process.platform === "win32" ? "sidecar.exe" : "sidecar"),
  ].filter((value): value is string => value !== undefined && existsSync(value))
  if (candidates.length === 0) {
    console.error("sidecar binary not found; run `cargo build -p ultracode-events` (debug) first")
    process.exit(2)
  }
  const sidecarBin = candidates[0]!
  const { EventsClient } = await import("@ultracode/events-client")
  const samples: number[] = []
  for (let run = 0; run < RUNS; run++) {
    const tmp = mkdtempSync(path.join(tmpdir(), "baseline-sidecar-"))
    const started = Date.now()
    const client = EventsClient.start({
      journalDir: path.join(tmp, "journal"),
      db: path.join(tmp, "events.db"),
      artifacts: path.join(tmp, "artifacts"),
      sidecarBin,
      session: "baseline",
    })
    await client.ping()
    samples.push(Date.now() - started)
    client.stop()
  }
  return samples
}
```

Implementation notes for the subagent:
- **TTFT**: copy the full recorded-runner stack from `packages/core/test/session-runner-recorded.test.ts` (cassette `session-runner/openai-chat-streams-text`, replay via `HttpRecorder.http`). Drive it directly with `Effect.runPromise` (not `it.effect`): admit a prompt with `session.prompt({...})`, then fork `session.resume(sessionID)` and simultaneously subscribe `events.listen` (the same `EventV2.Service.listen` signature `scheduler-service.ts` uses), resolving a `Deferred` on the first `SessionEvent.Text.Delta.type` event for that session id. `ttft = Date.now() - promptAdmitted`. Await the resume fiber after. New session id per run (`ses_baseline_${run}`). The `events` reference is the `EventV2.Service` instance the runner publishes through.
- **idle memory**: after the last TTFT run completes, loop `RUNS` times: `await Bun.sleep(200)`, push `process.memoryUsage().rss / 2 ** 20` (MB). These samples are taken in the same process after session work settles.
- Sidecar: `EventsClient.start` (RUN-01) spawns the binary and handshakes; `client.ping()` is the first round trip, so `start → ping` IS the spawn-latency window. If `EventsClient.start` blocks on an env probe, pass `environment`/`developmentBin` overrides matching RUN-01's `resolveSidecarBin` search order (verify against `packages/ultracode-events-client/src/index.ts` while implementing).

Write `perf/baselines.json` (captured_at ISO, reference_machine `docs/benchmarks/environment.json`) and print the summary table. Do not assert any threshold.

- [ ] **Step 4: Run the harness** — `bun run perf/baseline.ts` from repo root (sidecar must be built first: `cargo build -p ultracode-events`). Expected: four `summarize` rows printed and `perf/baselines.json` written with numeric values.
- [ ] **Step 5: Run the sanity test, watch it pass** — `cd packages/core && bun test test/perf/baselines.test.ts`
- [ ] **Step 6: Commit** — stage `perf/baseline.ts`, `perf/baselines.json`, `packages/core/test/perf/baselines.test.ts`:

```bash
git add perf/baseline.ts perf/baselines.json packages/core/test/perf/baselines.test.ts
git commit -m "chore(perf): committed record-only baselines for startup, ttft, idle memory, sidecar spawn"
```

---

### Task 6: Docs and run-ledger registry updates

**Files:**
- Create: `perf/baselines.md`
- Modify: `specs/v2/session.md` (add "Capability Profiles at Runtime" + "Budget Spine" + "Diagnostics" section)
- Modify: `TODO/README.md` (§7 Cross-Run Interface Registry — refine the RUN-05 row with exact symbols)

**Interfaces:**
- Consumes: the produced symbols from Tasks 1–5 (verified by grep before writing).
- Produces: committed documentation and registry accuracy only.

- [ ] **Step 1: Verify reality** (this is the task's "test") — run:
```bash
cd packages/ultracode-schema && bun test test/cache-policy.test.ts test/profile-conformance.test.ts 2>&1 | tail -3
cd packages/core && bun test test/capability/profile.test.ts test/capability/diagnostics.test.ts 2>&1 | tail -3
cd packages/opencode && bun test test/agent/scheduler-budget-spine.test.ts test/server/httpapi-authority-diagnostics.test.ts 2>&1 | tail -3
bun run perf/baseline.ts 2>&1 | tail -6
```
Expected: green; `perf/baselines.json` present.

- [ ] **Step 2: Write `perf/baselines.md`** — document: the four metrics, the run command (`bun run perf/baseline.ts` from repo root, sidecar prerequisite `cargo build -p ultracode-events`), the output file `perf/baselines.json` and its schema, the record-only policy (quote `packages/app/e2e/performance/AGENTS.md` items 11–12: "Do not enforce machine-dependent performance thresholds" / "assert scenario completion and metric collection only"), and link `docs/benchmarks/environment.json` as the reference-machine record.
- [ ] **Step 3: Update `specs/v2/session.md`** — add a section covering:
  - Profile resolution: `Profile.resolve(model, { ttlSeconds? })` per (route, model); seed from route family + default limits; `CONSERVATIVE_PROFILE` when the route carries no limits; deterministic `profileId` persisted per step.
  - Cache policy: `profileCachePolicy` maps `caching.mode` → request `cache`; ttl pass-through enables the llm 1h tier for scheduler children.
  - Compaction/output: buffer = `profile.outputTokens`; generation clamped to `min(outputTokens, limits remaining)`.
  - Budget spine: child supervise `Limits.maxTokens` = durable DAG reservation; `budget_exhausted` is a terminal task/deliverable state; actual spend recorded via `useChildBudget` on the root, per-child reclaim retained.
  - Diagnostics: `step_usage` table fields + `GET /experimental/authority/sessions/:sessionId/diagnostics` paging contract.
- [ ] **Step 4: Update the registry** — in `TODO/README.md` §7, replace the RUN-05 row:
```
| RUN-05 | `CapabilityProfile` resolution in runner + diagnostics routes | `packages/core/src/session/runner/model.ts` | RUN-10, RUN-12, RUN-13 |
```
with:
```
| RUN-05 | `Profile.resolve`/`profileId` (per route+model) + `SessionDiagnostics.Service` + `GET /experimental/authority/sessions/:id/diagnostics` | `packages/core/src/capability/{profile,diagnostics}.ts`, `packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/authority.ts` | RUN-10, RUN-12, RUN-13 |
```
- [ ] **Step 5: Verify** — `grep -c "Capability Profiles at Runtime" specs/v2/session.md` ≥ 1; `test -f perf/baselines.md`; `grep -c "SessionDiagnostics.Service" TODO/README.md` ≥ 1.
- [ ] **Step 6: Commit**

```bash
git add perf/baselines.md specs/v2/session.md TODO/README.md
git commit -m "docs: document profile runtime, budget spine, diagnostics, and baseline procedure"
```

---

## Run-Level Review Prompt (dispatch after Task 6)

```
Review the commits <list hashes> in /home/thymia/UltraCode-Planning/opencode
implementing RUN-05 (file: opencode/TODO/RUN-05-capability-diagnostics.md).
Run-specific checks:
1. Dependency rule: `@ultracode/schema` is imported by packages/core and by no
   package beneath it; no package imports `packages/llm` cache types into
   `@ultracode/schema` (schema stays llm-free).
2. One-owner rule: step usage is written only through `SessionDiagnostics.Service`
   into the core SQLite `step_usage` table; no TS code writes sidecar journal
   events for session steps; the sidecar changes are limited to the
   `budget_exhausted` terminal state (no envelope/method changes).
3. Budget spine: supervise `maxTokens` derives solely from the durable task
   budget (`deriveExecutionLimits`); actual spend is recorded via
   `useChildBudget` on the root and `validateSpawn` skips terminal siblings;
   no double counting of child spend.
4. `budget_exhausted` is terminal everywhere: TS `TaskState`/`transitionTaskState`/
   `isTerminal`/`DeliverableInput.status` AND every Rust terminal/transition
   match arm + `terminal_details`.
5. Determinism: `Profile.resolve` is pure over the resolved model; `profileId`
   is a pure string function; the runner passes it unchanged into diagnostics.
6. No machine-dependent thresholds anywhere in perf/ or its tests.
7. `packages/client/src/generated*` untouched by hand; only `bun run generate` output.
8. Diff scope: only files declared in the run plan.
Then the generic checks from TODO/README.md §5.1 items 1–5.
Reply numbered findings, BLOCKER or MINOR, file:line. No edits.
```

## Deviation Log (fill during execution)

| Task | Deviation | Reason |
|---|---|---|
| 4 | Step-usage projection lands in core SQLite (`step_usage`), not sidecar projections | The sidecar does not own session-step data until RUN-13/A2; EventV2 owns sessions today, so the one-owner rule places the session-scoped diagnostics table next to `SessionTable`. The audit's R9 "sidecar projections" wording applies post-A2 and is tracked there. |
| 3 | `useChildBudget` is applied to the ROOT task (not the child) so `root.budget_used` becomes the single spend audit; child-level `reclaimChildBudget` is retained as per-child returned-reservation audit and `validateSpawn` now skips terminal siblings to avoid double counting | Matches the audit's A1.5 intent (one numeric spine) while preserving the sidecar's existing spawn-time pool gating. |
| 3 | Existing `packages/opencode/test/agent/scheduler.test.ts` line ~652 assertion flipped (`task-budget-used` now emitted) | Intentional behavior change of the spine; the assertion previously pinned the "never recorded" gap the run fixes. |
