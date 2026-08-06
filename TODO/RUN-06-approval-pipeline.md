# RUN-06: Unified Approval Pipeline — Policy Rules, Amendments, Review Lane, Decision System, Role Models

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the V1/V2 permission duality with ONE approval pipeline for every tool side effect — ordered policy rules → grant check → optional review-model lane → user prompt with amendment option → journaled verdict — plus a Codex-inspired decision system (≤4 options, notes, follow-up constraints) and per-role model/effort config. Deny-by-default must remain. Everything Codex-inspired is reimplemented in TypeScript, never copied (provenance ledger entry required, see Task 8).

**Architecture:** A single `ApprovalPipeline` entry point in `packages/core/src/permission/pipeline.ts` composes a TS-native JSON exec-policy rule engine (layered global → project → session; rule kinds: bash-prefix using the EXISTING tree-sitter command decomposition, path patterns, MCP server:tool), the existing V2 grant/profile/saved evaluation (unchanged semantics, characterized in Task 1), an optional `ReviewLane` ("approve for me"), and the existing user-prompt/amend machinery. The dead `permission.ask` plugin hook is WIRED as a synchronous policy consultor consulted before user prompting, verdicts journaled as `approvalSource: "plugin"`. Decisions share one `Decision.Record` shape across the `question` tool and plan-mode exits. Role config (`agentRoles`, `permission.reviewModel`) resolves models/effort for scheduler child spawn, compaction summarization, and the review lane.

**Tech Stack:** Bun, TypeScript, Effect-TS, Effect Schema, Drizzle/SQLite (existing), tree-sitter bash/PowerShell WASM (existing, `packages/opencode/src/tool/shell.ts`), `@opencode-ai/llm` `LLM.generateObject` for strict review-model JSON.

**Audit basis:** §13 (approval orchestration shape; speculative permission base), §15 (Codex orchestrator/execpolicy/Guardian/BANNED_PREFIX_SUGGESTIONS), §17.2 (Codex ideas), §18-A5 (one approval path), §20.2 ("approve for me" review lane), §22 Agent Control items (approve for me → P1; per-role model/effort; decision system), R5 (homogenize structured human input), TODO.md items 15, 19, 20, 21.

**Provenance:** This run reimplements (does NOT copy) Codex's exec-policy + Guardian + amendment concepts. Source of record: `/home/thymia/UltraCode-Planning/codex` at pinned commit `0a0ebb85355113610dd3f7a3d8b36f68c33465fc`, reference files `codex-rs/core/src/exec_policy.rs`, `codex-rs/core/src/guardian/`, `codex-rs/core/src/command_canonicalization.rs`. Task 8 writes the `docs/provenance/ledger.json` entry (treatment `reimplement`).

## Global Constraints

All constraints in `TODO/README.md` §2 apply verbatim. In addition:

- **One owner (constraint #4):** `ApprovalPipeline` is the ONLY approval verdict path. No new second permission entry point; leaves keep calling `PermissionV2.assert`/`ask` which delegate into the pipeline.
- **Deny-by-default must remain:** unresolvable agents still resolve to `[{action:"*", resource:"*", effect:"deny"}]`; a policy or review verdict can never broaden an existing configured `deny`.
- **Never fail open:** review-model failure routes to the user prompt (fail to user), never silently allows and never silently denies the action.
- **Provenance (constraint #5, quoted):** "no code from `../codex` or `../claude-code-sourcemap` may enter this repo without an entry in `docs/provenance/ledger.json` validated by `bun run scripts/provenance/validate.ts`." This run touches Codex-inspired designs, so Task 8 is MANDATORY: create `docs/provenance/sources.json` + `docs/provenance/ledger.json`, run the validator, and the run is NOT DONE without a green validator output.
- **Schema/Protocol:** changing `Permission.Decision.approvalSource` or `Question` schemas requires `bun run generate` from `packages/client` (constraint #7). Never hand-edit `packages/client/src/generated*`.
- **V1 freeze (constraint #10):** `packages/opencode/src/session/{prompt,processor,session}.ts` are bugfix-only. The V1 `question` tool is NOT modified; `packages/opencode/src/tool/plan.ts` and `packages/opencode/src/permission/index.ts` are NOT in the freeze list and may be touched minimally.
- **Branch:** `approval-pipeline`.

## Orchestrator Brief

### Context Files (read in full before dispatching Task 1)

1. `packages/core/src/permission.ts` — V2 service: `evaluate` last-match-wins, `mergeNarrowing`, `resolveProfile`, `evaluateInput` (deny → grant → saved-rules aggregation), `ask`/`assert`/`reply`, pending-request + grant maps, `Event.Asked`/`Event.Replied`, `finalizedDecision` forcing `approvalSource: "user"`. The pipeline refactor (Task 7) must preserve this.
2. `packages/core/src/permission/saved.ts` + `packages/core/src/permission/sql.ts` — project-persisted `PermissionSaved` (`action`, `resource`, effect always `allow`).
3. `packages/schema/src/permission.ts` — `Decision` (`approvalSource: ["policy","grant","user"]`), `Reply` (`once|session|project|always|reject`), `Request`, `Grant`, `Event`. Task 7 extends `approvalSource` with `"review" | "plugin"`.
4. `packages/opencode/src/permission/index.ts` — V1 permission service (`evaluate`, `ask`, `reply`, `approved` set). This is where the `permission.ask` plugin hook decision lands (Task 1 step 2); the hook is fired in the V2 consultor adapter (Task 7).
5. `packages/opencode/src/permission/arity.ts` — `BashArity.prefix(tokens)` canonical command prefix; used by the policy engine's bash-prefix matching (Task 2) and amendments (Task 3).
6. `packages/opencode/src/tool/shell.ts` — the EXISTING tree-sitter decomposition (`parse`, `collect`, `parts`); `scan.always` already computes `BashArity.prefix(tokens).join(" ") + " *"`. The bash-prefix policy rule consumes `commandTokens` produced here (threaded through the permission request metadata).
7. `packages/opencode/src/agent/scheduler-service.ts` — audit bridge (`PermissionV2.Event.Replied` → `proposeCommit("approval:...", {kind:"approval-finalized", ...})`); child `session.create` region that consumes `input.model` (Task 6 role resolution).
8. `packages/opencode/src/tool/task.ts` — model inheritance at lines ~153–160 (`next.model ?? ctx.extra?.model`); `deriveChildPolicy`. Task 6 adds optional `model`/`effort` params + role resolution.
9. `packages/core/src/tool/question.ts` (V2 question tool), `packages/opencode/src/tool/question.ts` + `question.txt` (V1, do NOT modify), `packages/opencode/src/tool/plan.ts` (plan-mode exit; emits a decision record in Task 5), `packages/schema/src/question.ts` (`Question.Prompt`/`Info`, `Answer`).
10. `packages/core/src/session/compaction.ts` — `make({events, llm, config})`; summarization LLM call uses `input.model` (Task 6 adds the `compaction` role).
11. `packages/core/src/config.ts` — `Config.Info` (add `permission.reviewModel`, `agentRoles`), `Config.latest`, `Config.Document/Entry`; `packages/core/src/config/agent.ts` (`ConfigAgent.Info`); `packages/core/src/session/runner/model.ts` (`SessionRunnerModel.resolve(session)` — the model resolution seam for the review lane); `packages/llm/src/llm.ts` (`LLM.generateObject`, `LLM.request`, `Message.user`, `Schema`).
12. `packages/plugin/src/index.ts` — dead `"permission.ask"?: (input: Permission, output: {status:"ask"|"deny"|"allow"}) => Promise<void>` (line 261). `packages/opencode/src/plugin/index.ts` — `Plugin.Service.trigger(name, input, output)` mutates output in place; `LayerNode.make({service, layer, deps})`.
13. `packages/core/test/permission.test.ts` — existing V2 test harness (`testEffect`, `AppNodeBuilder`, fixture `location`). Follow this harness for all new core permission tests.
14. `scripts/provenance/validate.ts` — ledger validator contract (see Task 8 for the exact `sources.json`/`ledger.json` shapes it requires).
15. One Protocol group file: `packages/protocol/src/groups/permission.ts` — endpoint conventions if any endpoint changes; RUN-06 adds no new endpoints (evaluation/policy exposure stays in the existing `PermissionV2` surface). If a task discovers an endpoint change is needed, follow this file's pattern.

### Baselines (record before Task 1)

```bash
cd packages/opencode && bun test test/permission 2>&1 | tail -5
cd packages/opencode && bun typecheck 2>&1 | tail -5
cd packages/core && bun test test/permission.test.ts 2>&1 | tail -5
cd packages/core && bun typecheck 2>&1 | tail -5
cd packages/schema && bun test 2>&1 | tail -5
cd packages/opencode && bun run scripts/provenance/validate.ts 2>&1 | tail -5   # note: run from repo root
```

### Dispatch Order

Tasks 1 → 8 strictly sequential. Task 1 is characterization (no production change; may be green immediately). Tasks 2–4 build independent pieces; still run in order because Task 7 (pipeline) composes all of them.

### Definition of Done (verify each with a command you ran)

- [ ] `rg -n 'approvalSource: "review"' packages/core/test/permission/pipeline.test.ts` matches (review verdict journaled as an approval record).
- [ ] `rg -n 'trigger\("permission.ask"' packages/opencode/src/plugin/index.ts` matches (dead hook WIRED, decision recorded in Task 1).
- [ ] `rg -n 'maxItems\(4\)' packages/schema/src/question.ts` matches (≤4 options enforced in schema).
- [ ] `rg -n 'reviewModel' packages/core/src/config.ts` matches (`permission.reviewModel` config key).
- [ ] `rg -n 'agentRoles' packages/core/src/config.ts` matches (role model config key).
- [ ] `rg -n 'BANNED_PREFIX_SUGGESTIONS' packages/core/src/permission/amend.ts` matches.
- [ ] `bun run scripts/provenance/validate.ts` from repo root prints `PROVENANCE OK`.
- [ ] `bun typecheck` passes in `packages/schema`, `packages/core`, `packages/opencode`, `packages/plugin`.
- [ ] `bun run generate` from `packages/client` succeeded after the schema changes (Tasks 5, 7); generated files untouched by hand.
- [ ] `git status` clean; branch `approval-pipeline`; §7 registry row for RUN-06 written.

---

### Task 1: Characterize current V2 permission evaluation + record the `permission.ask` hook decision

**Files:**
- Create: `packages/core/test/permission/characterization.test.ts`
- Modify: none (production) — the test suite IS this task's deliverable; it pins the contract the pipeline (Task 7) must keep green.

**Interfaces:**
- Consumes: `PermissionV2` (`evaluate`, `mergeNarrowing`, `resolveProfile`, `Service.ask`/`assert`/`reply`/`list`), `PermissionSaved`, `EventV2`.
- Produces: no new production interface. A characterization contract in test form. The run-level review will diff this suite against the audit claims.

- [ ] **Step 1: Read first.** `packages/core/src/permission.ts`, `packages/core/test/permission.test.ts`, `packages/schema/src/permission.ts`, `packages/opencode/src/permission/index.ts`. Note the existing `permission.test.ts` already covers profile narrowing and grant semantics; do not duplicate those wholesale — characterize what the pipeline MUST preserve that is NOT yet pinned: per-resource aggregation, decision-field selection, and the unmatched→ask fallback.

- [ ] **Step 2: Record the hook decision (explicit step).** Decide the fate of the dead `permission.ask` plugin hook (`packages/plugin/src/index.ts:261`). **Decision: WIRE it** (recommended; do not remove). Rationale to paste into the commit message: plugins may register synchronous policy consultors consulted BEFORE user prompting; verdicts journaled as `approvalSource: "plugin"`; this preserves the hook's declared contract while giving it a real, auditable path. Wiring is implemented in Task 7; Task 1 only records the decision. If the implementer finds wiring impossible for a structural reason (e.g. cross-package layering), STOP and record the blocker in the Deviation Log rather than silently removing the hook.

- [ ] **Step 3: Write the characterization tests** — `test/permission/characterization.test.ts`, following the harness in `test/permission.test.ts` (build the layer group with `PermissionV2.node` + `Database.node` + `EventV2.node` + `SessionStore.node` + `PermissionSaved.node` + `AgentV2.node`, fixture location `/project`). Assert at minimum:
  1. `evaluate` is last-match-wins and returns the `{action, resource:"*", effect:"ask"}` fallback on no match.
  2. Per-resource aggregation: `ask({action:"bash", resources:["echo hi","rm -rf /"]})` with rules `echo * → ask`, `rm * → deny` returns `effect:"deny"` (deny beats ask across resources) and leaves the pending list empty.
  3. Grant precedence: an active `session` grant allows, but a LATER configured deny still blocks (`assert` → `BlockedError`), matching `permission.test.ts` "does not let an expiring grant override a later configured deny".
  4. Saved-rules layering: `PermissionSaved.add` rows layer AFTER configured rules; a configured `deny` still wins over a saved `allow`.
  5. Deny-by-default: with no resolvable agent (`agents` map empty, session agent `null`), `ask` returns `deny` and journals no pending request.
  6. Decision audit fields: a pending request's `decision` carries `requestedAction`, `requestedResources`, `agent`, `approvalSource: "policy"`, and `matchedRule` is the last rule matching the evaluated effect.
  7. `reply("always")` persists saved resources and cascades to matching pending same-session requests; `reply("reject")` cancels all same-session pending.
  8. Journaled `Event.Replied` carries `{sessionID, requestID, reply, decision, grant?, workspaceDirectory, projectID}` (the scheduler audit bridge depends on this shape — do not regress).

- [ ] **Step 4: Run the suite** — `cd packages/core && bun test test/permission/characterization.test.ts`. Expect GREEN on first run (characterization). If any assertion FAILS, the audit claim disagrees with reality: do NOT change production code to make it pass; record the failing dimension in the Deviation Log with the actual behavior.

- [ ] **Step 5: Typecheck** — `cd packages/core && bun typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/test/permission/characterization.test.ts
git commit -m "test(core): characterize v2 permission evaluation contract; decide to wire permission.ask hook"
```

---

### Task 2: TypeScript-native JSON exec-policy rule engine

**Files:**
- Create: `packages/core/src/permission/policy.ts`
- Create: `packages/core/test/permission/policy.test.ts`

**Interfaces:**
- Consumes: `Wildcard` (`@opencode-ai/core/util/wildcard`), `Config.Service` (`Config.latest`), `Location.Service` (project directory for project rules discovery), `Global` (`Global.Path.config` for the global rules file). Bash-prefix matching consumes the EXISTING tree-sitter decomposition via an optional `commandTokens` array in the policy request (produced by `packages/opencode/src/tool/shell.ts` `collect`/`parts`; the raw command string is the fallback).
- Produces (registry names):
  - `PolicyRule` = `Schema.Union` of three tagged kinds — `bash-prefix` (`{ kind, prefix: string[], effect, id?, comment?, amendedBy?, amendedAt?, matchedCommand? }`), `path` (`{ kind, action, pattern, effect, id?, comment? }`), `mcp` (`{ kind, server?, tool?, effect, id?, comment? }`), each `effect: "allow" | "ask" | "deny"`.
  - `PolicyVerdict = Schema.Literals(["allow", "ask", "deny", "unmatched"])`.
  - `PolicyRequest = { action: string; resources: readonly string[]; commandTokens?: readonly string[]; mcp?: { server: string; tool: string } }`.
  - `PolicyResult = { verdict: PolicyVerdict; matchedRule?: PolicyRule; layer?: "global" | "project" | "session" }`.
  - `Policy.Service` (`@opencode/v2/Policy`) with `evaluate(input: PolicyRequest): Effect<PolicyResult>`, `layers(): Effect<{global: PolicyRule[]; project: PolicyRule[]; session: PolicyRule[]}>`, `append(scope, rule): Effect<void>` (append used by amendments, Task 3).

- [ ] **Step 1: Write the failing test** — `test/permission/policy.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Policy } from "../../src/permission/policy"
import { testEffect } from "../lib/effect"

// pure engine tests (no layer needed)
describe("Policy.evaluate", () => {
  test("bash-prefix matches against commandTokens and wins over raw resource", () => {
    const result = Policy.matchRule(
      { kind: "bash-prefix", prefix: ["git", "push"], effect: "allow" },
      { action: "bash", resources: ["git push origin main"], commandTokens: ["git", "push", "origin", "main"] },
    )
    expect(result).toBe(true)
  })
  // ... plus: no token match -> raw-string wildcard fallback; empty prefix is a bash wildcard
  test("path rule matches resources by Wildcard", () => {
    const rule = { kind: "path", action: "edit", pattern: "src/*", effect: "deny" } as const
    expect(Policy.matchRule(rule, { action: "edit", resources: ["src/secret.ts"] })).toBe(true)
    expect(Policy.matchRule(rule, { action: "edit", resources: ["test/a.ts"] })).toBe(false)
  })
  test("mcp rule matches server:tool", () => {
    const rule = { kind: "mcp", server: "github", tool: "*", effect: "ask" } as const
    expect(Policy.matchRule(rule, { action: "mcp", resources: [], mcp: { server: "github", tool: "create_issue" } })).toBe(true)
  })
})
```

Then layer-backed tests via `testEffect` (location fixture, tmp config dir):
```ts
it.effect("layers global->project->session with later layers winning", () => { /* ... */ })
it.effect("returns unmatched when no rule applies (existing heuristics fallback)", () => { /* ... */ })
it.effect("within a layer, last matching rule wins", () => { /* ... */ })
```

- [ ] **Step 2: Run it, watch it fail** — `cd packages/core && bun test test/permission/policy.test.ts` → module missing.
- [ ] **Step 3: Write minimal implementation** — `src/permission/policy.ts`. Match semantics: (a) `bash-prefix`: match iff `commandTokens[0..prefix.length)` equals `prefix`, OR (no `commandTokens`) the raw first resource matches `Wildcard.match(resource, prefix.join(" ") + " *")`; `prefix: []` matches any `bash` action. (b) `path`: `input.action` matches `rule.action` AND any resource matches `Wildcard.match(resource, rule.pattern)`. (c) `mcp`: when `rule.server` set it must `Wildcard.match(server, rule.server)`; when `rule.tool` set it must `Wildcard.match(tool, rule.tool)`. Evaluation order: within a scope, iterate rules in file order, keep the LAST match per (kind, action) (consistent with existing `evaluate` last-match-wins); scope precedence is `session > project > global` (a matching session rule overrides project/global). Verdict: first non-`unmatched` result across scopes by precedence; `deny` from any scope is returned immediately (deny beats ask/allow). Rule-file discovery: `global` = `<Global.Path.config>/permission.rules.json`; `project` = walk up from `Location.directory` to project root for `.opencode/permission.rules.json` (same discovery shape as `Config` layer); `session` = in-memory array seeded empty (amendment/session writes land here unless scope project is chosen). Use `Bun.file` + `Schema.decodeUnknownOption(PolicyFile)`; missing files contribute `[]`. Repo style: happy-path export on top, helpers below; no `else`.
- [ ] **Step 4: Run test, watch it pass** — same command as Step 2.
- [ ] **Step 5: Typecheck** — `cd packages/core && bun typecheck`.
- [ ] **Step 6: Commit** — `feat(core): json exec-policy rule engine layered global/project/session`.

---

### Task 3: Amendment offer + persist with banned wrapper blocklist

**Files:**
- Create: `packages/core/src/permission/amend.ts`
- Create: `packages/core/test/permission/amend.test.ts`

**Interfaces:**
- Consumes: `Policy.Service` (Task 2: `append`), `BashArity.prefix` semantics (ported contract, `packages/opencode/src/permission/arity.ts` — read it, do not import across packages), `Config.Service`, `Location.Service` (project directory for the project rules file).
- Produces (registry names):
  - `BANNED_PREFIX_SUGGESTIONS: readonly string[]` — Codex `BANNED_PREFIX_SUGGESTIONS` analog, reimplemented not copied. Initial set: `["sudo", "env", "xargs", "sh -c", "bash -c", "eval", "timeout", "nohup", "nice", "stdbuf", "setsid", "chroot", "unshare", "watch"]`. Commands whose canonical prefix starts with any of these are NEVER amendable (whitelisting a wrapper would whitelist anything it runs).
  - `AmendmentOffer = { rule: PolicyRule; suggestion: string }`.
  - `PermissionAmend.Service` (`@opencode/v2/PermissionAmend`) with `offer(input: { sessionID; action; resource; commandTokens? }): Effect<AmendmentOffer | undefined>` and `persist(input: { projectID; rule: PolicyRule; provenance: { source: "user"; at: number; matchedCommand: string } }): Effect<void>`.
  - Note in the plan: `offer` returns `undefined` when (a) action is not `bash`, (b) canonical prefix starts with a banned wrapper, or (c) the canonical prefix is empty (a bare `*` rule is never amendable). `persist` writes the rule into the project rules file (`<project>/.opencode/permission.rules.json`) preserving existing rules (read-modify-write; treat the file as user-owned config, NOT the journal — one-owner rule applies to the journal only), then `Policy.Service.append("project", rule)`.

- [ ] **Step 1: Write the failing test** — `test/permission/amend.test.ts`:

```ts
it.effect("offer for git push (non-banned) yields a bash-prefix rule", () => { /* ... */ })
it.effect("offer for `sudo apt install x` is undefined (banned wrapper)", () => { /* ... */ })
it.effect("offer for non-bash action is undefined", () => { /* ... */ })
it.effect("persist writes the rule file and Policy.Service evaluates it afterward", () => {
  // tmp project dir; persist a git push allow rule; Policy.evaluate({action:"bash", resources:["git push origin main"], commandTokens:[...]}) -> allow
})
it.effect("persist preserves existing rules already in the file", () => { /* ... */ })
```

- [ ] **Step 2: Run, watch fail** — `cd packages/core && bun test test/permission/amend.test.ts`.
- [ ] **Step 3: Implement** — `src/permission/amend.ts`. Canonical prefix from `commandTokens` via a ported `prefix(tokens)` helper (copy the arity dictionary behavior ONLY as a reference contract; the dictionary itself is generated data from V1 — reuse `BashArity.prefix` by importing it if the import graph allows, otherwise reimplement the single `prefix` function here; record the choice in the Deviation Log). Banned check: first `prefix` result — if the canonical prefix is exactly a banned wrapper or starts with `<banned> `, return `undefined`. `persist`: read existing JSON (missing → `[]`), filter out an identical existing rule, append, write pretty JSON, then `Policy.Service.append("project", rule)`.
- [ ] **Step 4: Run, watch pass; then `bun typecheck`.**
- [ ] **Step 6: Commit** — `feat(core): bash-prefix amendment offer and persist with banned wrapper blocklist`.

---

### Task 4: Review-model lane ("approve for me")

**Files:**
- Create: `packages/core/src/permission/review.ts`
- Create: `packages/core/test/permission/review.test.ts`

**Interfaces:**
- Consumes: `LLMClient.Service` + `LLM.generateObject` (`@opencode-ai/llm`), `SessionRunnerModel.Service` (model resolution seam), `Config.Service` (`permission.reviewModel`, Task 6 provides the full config field; Task 4 may read the field if present), `SessionStore.Service` (fallback session model), `RoleModels` (Task 6 — review lane uses role `"review"`; keep the dependency optional/injected so Task 4 lands before Task 6).
- Produces (registry names):
  - `ReviewVerdict = Schema.Struct({ approve: Schema.Boolean, reason: Schema.String })` (strict JSON; the review-model output contract).
  - `ReviewInput = { sessionID; agent?; action; resources; summary: string; command? }`.
  - `ReviewLaneError` — `Schema.TaggedErrorClass` (`ReviewLane.ReviewLaneError`, fields `{ reason: Schema.String }`).
  - `ReviewLane.Service` (`@opencode/v2/ReviewLane`) with `review(input: ReviewInput): Effect<ReviewVerdict, ReviewLaneError>`.
  - `ReviewLane.layerWith({ review })` — the injected fake review-model seam for tests (REAL function seam, not module mocks). Production layer builds `review` from `LLMClient.generateObject({ schema: ReviewVerdict, model, messages: [Message.user(summary)] })` with `model` = configured review model (config `permission.reviewModel` resolved via catalog, else session model), and maps any `LLMError`/decode failure to `ReviewLaneError` (fail closed).

- [ ] **Step 1: Write the failing test** — `test/permission/review.test.ts` (pure seam tests + one layer test):

```ts
import { Effect, Layer } from "effect"
import { ReviewLane } from "../../src/permission/review"

it.effect("approve=true resolves", () => {
  // ReviewLane.layerWith({ review: () => Effect.succeed({ approve: true, reason: "safe" }) })
})
it.effect("approve=false resolves as a verdict (caller decides to prompt the user)", () => { /* ... */ })
it.effect("malformed/throws -> ReviewLaneError (fail closed)", () => {
  // seam that returns { approve: "not-a-boolean" } as unknown -> the layer must reject with ReviewLaneError
})
it.effect("review never enqueues a pending permission request (loop guard)", () => {
  // run a full PermissionV2.assert through a pipeline-ish composition where the review lane is consulted;
  // assert PermissionV2.list() stays empty and no Event.Asked is published while review is running
})
```

- [ ] **Step 2: Run, watch fail** — `cd packages/core && bun test test/permission/review.test.ts`.
- [ ] **Step 3: Implement** — `src/permission/review.ts`. Happy path: `review` builds a compact summary from `ReviewInput` (≤~2KiB; action, resources joined, `command` if present, agent), calls the injected `review` seam (production seam uses `LLM.generateObject` with strict `ReviewVerdict` — malformed model JSON is a real `LLMError`), and returns the verdict. Loop guard is structural: the review lane NEVER yields `PermissionV2.Service` or `ApprovalPipeline.Service`; its LLM call is a bare `LLMClient.generateObject` (no permission gate), so the review model's own tool calls cannot recurse into review.
- [ ] **Step 4: Run, watch pass; then `bun typecheck`.**
- [ ] **Step 6: Commit** — `feat(core): review-model lane with strict json verdict and fail-closed errors`.

---

### Task 5: Decision system — ≤4 options, notes, follow-up constraints, shared record with plan-mode

**Files:**
- Create: `packages/schema/src/decision.ts`
- Modify: `packages/schema/src/question.ts` (`Question.Prompt`/`Info` base: `options` gets `Schema.maxItems(4)`; add optional `notes` and `followUp` string fields)
- Modify: `packages/core/src/tool/question.ts` (emit a `Decision.Record` per question in the typed `Output`)
- Modify: `packages/opencode/src/tool/plan.ts` (record the exit choice as a `Decision.Record`, source `"plan_exit"`)
- Create: `packages/schema/test/decision.test.ts`, `packages/core/test/tool/question.test.ts` (create dir/file if absent)

**Interfaces:**
- Consumes: `QuestionV2.Prompt`/`Info` (V2 and V1 share these schema types), `QuestionV2.Service` (`question.ask`), existing question tool flow.
- Produces (registry names):
  - `Decision.ID` (brand `"dec_"`), `Decision.Option = { label, description?, recommended? }`, and **`Decision.Record`** = `Schema.Struct({ id: ID, prompt: String, options: Array(Option).pipe(Schema.maxItems(4)), notes: String.pipe(optional), followUp: String.pipe(optional), selected: Array(String), source: Literals(["question", "plan_exit"]) })` in `packages/schema/src/decision.ts`. This is the ONE record type shared by the `question` tool and plan-mode exits (audit R5).
  - `Question` schema changes: `base.options` = `Schema.Array(Option).pipe(Schema.maxItems(4))`; `base` gains `notes: String.pipe(optional)` and `followUp: String.pipe(optional)` (surfaces to both `Question.Info` and `Question.Prompt`).

- [ ] **Step 1: Write the failing tests**
  - `packages/schema/test/decision.test.ts`: `Decision.Record` decodes with 4 options; REJECTS 5 options (`Schema.decodeUnknownOption` → `none`); `selected` ≤ 4; `source` literal union; optional `notes`/`followUp` omitted when undefined (use the `optional(...)` helper, schema-package convention).
  - `packages/core/test/tool/question.test.ts`: the V2 question tool's `Input` schema rejects a `questions[].options` array of length 5 (decode failure → `ToolFailure`), accepts notes/followUp; the tool `Output` includes a `decisions: Decision.Record[]` array aligned with `answers`.
- [ ] **Step 2: Run, watch fail** — `cd packages/schema && bun test test/decision.test.ts` and `cd packages/core && bun test test/tool/question.test.ts`.
- [ ] **Step 3: Implement** — schema `decision.ts` + `question.ts` changes (constraint: 4 max). V2 question tool: after `question.ask`, build `Decision.Record`s (`selected` from answers; `notes`/`followUp` from the prompt) and include them in `Output`; include `followUp` in the model-facing output text ("Follow-up constraints: …") so the model honors them. `plan.ts`: after the existing Yes/No ask, emit a `Decision.Record` (`source: "plan_exit"`, `selected: ["Yes"] | ["No"]`) in the tool output metadata so both human-input flows share one record type.
- [ ] **Step 4: Run, watch pass** — both suites.
- [ ] **Step 5: Regenerate the client** — `cd packages/client && bun run generate` (constraint #7; `Question` schemas flow into generated surface). Do not hand-edit generated files.
- [ ] **Step 6: Typecheck** — `cd packages/schema && bun typecheck`, `cd packages/core && bun typecheck`, `cd packages/opencode && bun typecheck`.
- [ ] **Step 7: Commit** — `feat(schema): decision record shared by question and plan-exit flows with max 4 options`.

---

### Task 6: Role-based model/effort config and resolution

**Files:**
- Modify: `packages/core/src/config.ts` (`Config.Info` gains `permission` and `agentRoles`)
- Create: `packages/core/src/agent/roles.ts`
- Modify: `packages/opencode/src/tool/task.ts` (optional `model`/`effort` params; resolution order)
- Modify: `packages/opencode/src/agent/scheduler-service.ts` (child spawn consumes resolved role model)
- Modify: `packages/core/src/session/compaction.ts` (`compaction` role for summarization model)
- Create: `packages/core/test/config/roles.test.ts`, `packages/opencode/test/tool/task-roles.test.ts`

**Interfaces:**
- Consumes: `Config.Service` (`Config.latest(entries, "agentRoles")`, `Config.latest(entries, "permission")`).
- Produces (registry names):
  - `Config.Info` additions:
    - `permission: Schema.Struct({ reviewModel: String.pipe(optional), reviewEffort: String.pipe(optional) }).pipe(optional)` (config key `permission.reviewModel`).
    - `agentRoles: Schema.Struct({ planner: RoleModel.optional, orchestrator: RoleModel.optional, subagent: RoleModel.optional, review: RoleModel.optional, compaction: RoleModel.optional, synthesis: RoleModel.optional }).pipe(optional)` where `RoleModel = Schema.Struct({ model: String.pipe(optional), effort: String.pipe(optional) })`.
  - `RoleModels.Ref = { providerID: string; modelID: string; effort?: string }`.
  - `RoleModels.Service` (`@opencode/v2/RoleModels`, module `packages/core/src/agent/roles.ts`) with `resolve(input: { role: Role; sessionModel?: Ref; explicit?: Ref }): Effect<Ref | undefined>`. Resolution order: `explicit` (ONLY when the user explicitly requested model/effort — e.g. the `task` tool's `model`/`effort` params) → `agentRoles[role]` → `sessionModel` → `undefined`.

- [ ] **Step 1: Write the failing test** — `test/config/roles.test.ts`: build `RoleModels.Service` over a `Config` layer whose document sets `agentRoles.subagent.model` and `permission.reviewModel`; assert `resolve({ role: "subagent", sessionModel })` returns the role model; `explicit` wins over role config; no config → `sessionModel`; role config present but no sessionModel → role model.
- [ ] **Step 2: Run, watch fail** — `cd packages/core && bun test test/config/roles.test.ts`.
- [ ] **Step 3: Implement** — config fields + `roles.ts` (pure service over `Config.Service`; `effort` surfaces alongside the model ref).
- [ ] **Step 4: Wire consumers.**
  - `task.ts`: add optional `model` (string `"provider/model"` style ref) and `effort` params to `BaseParameterFields`; resolution at line ~153: `explicit = parseModel(params.model)`; `model = explicit ?? yield* roles.resolve({ role: subagent-type-dependent (use "subagent"), explicit, sessionModel: ctx.extra?.model }) ?? next.model ?? ctx.extra?.model`. Thread `explicitModel`/`explicitEffort` onto the scheduler `agent` object only when the user explicitly set them.
  - `scheduler-service.ts` `session.create`: when `input.agent.explicitModel` is absent, resolve `RoleModels.resolve({ role: "subagent", sessionModel: input.model })` and use the result (falling back to `input.model`) for the child session `model`. Add `RoleModels.node` to the scheduler node deps.
  - `compaction.ts`: `make` dependencies gain `resolveRoleModel: (fallback) => Effect<Model | undefined>` (injected by `runner/llm.ts` from `RoleModels.Service`); summarization uses `resolveRoleModel(input.model) ?? input.model`.
  - `review.ts` (from Task 4): production `review` resolves the review model from `Config.latest(entries, "permission")?.reviewModel` else `RoleModels.resolve({ role: "review", sessionModel })`.
  - Test: `task-roles.test.ts` asserts the task tool prefers explicit `model` param, then role config, then inherited session model (via `TaskSchedulerAdapter` recorder), and rejects an unrecognized `model` string.
- [ ] **Step 5: Run all touched suites + typecheck** — `cd packages/core && bun test test/config/roles.test.ts && bun typecheck`; `cd packages/opencode && bun test test/tool/task-roles.test.ts && bun typecheck`.
- [ ] **Step 6: Commit** — `feat(core): per-role model/effort config resolved by explicit override then role then session`.

---

### Task 7: The unified ApprovalPipeline entry point + wired `permission.ask` plugin consultor

**Files:**
- Create: `packages/core/src/permission/plugins.ts` (`PolicyConsultors.Service`)
- Create: `packages/core/src/permission/pipeline.ts` (`ApprovalPipeline.Service`)
- Create: `packages/core/test/permission/pipeline.test.ts`
- Modify: `packages/core/src/permission.ts` (delegate `ask`/`assert` into the pipeline; keep `reply`/grant/pending machinery where it is; add the review-approve journaling path)
- Modify: `packages/schema/src/permission.ts` (`Decision.approvalSource` gains `"review" | "plugin"`)
- Modify: `packages/opencode/src/plugin/index.ts` (register the consultor that fires `trigger("permission.ask", ...)`; add `PolicyConsultors.node` to the plugin node deps)
- Create: `packages/opencode/test/permission/plugin-hook.test.ts`

**Interfaces:**
- Consumes: `Policy.Service` (Task 2), `ReviewLane.Service` (Task 4), `PermissionAmend.Service` (Task 3), existing `PermissionV2` internals (pending/grants/reply/saved), `Config.Service` (`permission.reviewModel`), `EventV2`.
- Produces (registry names — the ONE entry point):
  - `ApprovalPipeline.Service` (`@opencode/v2/ApprovalPipeline`, module `packages/core/src/permission/pipeline.ts`) with:
    - `evaluate(input: AssertInput): Effect<AskResult, Error>` — policy rules → grant check → review lane; returns the verdict WITHOUT creating a user prompt (preflight; consumed by RUN-08 speculative eval). When the review lane approves, journals `Event.Replied` with `decision.approvalSource: "review"` and reply `"once"`.
    - `ask(input): Effect<AskResult, SessionV2.NotFoundError>` — evaluate; on `ask` effect, consult `PolicyConsultors` then create the pending request (existing machinery).
    - `assert(input): Effect<void, Error | SessionV2.NotFoundError>` — evaluate; deny → `BlockedError`; allow → void; ask → consultors then pending-request await (existing `assert` behavior preserved exactly).
  - Pipeline order (single, fixed): `Policy.Service.evaluate` (a matched `deny` → `BlockedError` immediately, even if a review lane is configured — canonical policy is final authority; a matched `allow` → allow; a matched `ask` → review lane only if configured; `unmatched` → fall through to existing heuristic `evaluateInput`) → existing configured-rules/grant/saved evaluation → if effect is `ask` AND `permission.reviewModel` configured → `ReviewLane.review` → approve ⇒ allow + journal `approvalSource: "review"`; deny/failure ⇒ user prompt (fail to user) with the review reason surfaced in the prompt → `PolicyConsultors` consulted BEFORE the user prompt is created → `create(pending)` → user reply journals `approvalSource: "user"`.
  - `PolicyConsultors.Service` (`@opencode/v2/PolicyConsultors`, module `packages/core/src/permission/plugins.ts`): `register(consultor: { id: string; consult: (input: AssertInput) => Effect<"allow" | "deny" | "ask" | undefined> }): Effect<void>` and `list(): Effect<readonly Consultor[]>`; location-scoped, default empty. First consultor returning a verdict wins; `deny` → `BlockedError`; `allow` → allow with `decision.approvalSource: "plugin"`; `ask` → proceed to user prompt.
  - `Decision.approvalSource` extended to `Schema.Literals(["policy", "grant", "user", "review", "plugin"])`.
  - Wired `permission.ask` hook: `packages/opencode/src/plugin/index.ts` registers a consultor (id `"plugin:permission.ask"`) whose `consult` calls `Plugin.Service.trigger("permission.ask", { permission: input.action, patterns: input.resources, metadata: input.metadata }, { status: "ask" })` and returns `output.status` mapped to `allow|deny|ask` (a plugin hook may set any of the three).

- [ ] **Step 1: Write the failing tests** — `test/permission/pipeline.test.ts`:

```ts
it.effect("policy deny blocks even when a review lane is configured (canonical authority)", () => { /* ... */ })
it.effect("unmatched policy falls through to existing heuristic evaluation", () => { /* ... */ })
it.effect("review approve allows without a user prompt and journals approvalSource review", () => {
  // configure permission.reviewModel + ReviewLane.layerWith(approve seam); run pipeline.assert;
  // assert no pending request; assert the journaled Event.Replied decision carries approvalSource: "review"
})
it.effect("review deny degrades to a user prompt (fail to user, never fail open)", () => { /* ... */ })
it.effect("review failure degrades to a user prompt (never fail open)", () => { /* ReviewLaneError seam */ })
it.effect("plugin consultor allow journals approvalSource plugin without a user prompt", () => {
  // PolicyConsultors with a consultor returning "allow"; assert Event.Replied decision.approvalSource === "plugin"
})
it.effect("plugin consultor deny blocks with BlockedError", () => { /* ... */ })
it.effect("loop guard: review and consultor paths never enqueue a pending request", () => { /* list() stays empty */ })
```

  And `packages/opencode/test/permission/plugin-hook.test.ts` — build the opencode plugin host with a stub plugin implementing `permission.ask`, register the wired consultor, invoke it, assert the hook fired with `{permission, patterns}` and the mapped status; assert the hook is NOT fired for non-pending paths (policy allow/deny).

- [ ] **Step 2: Run, watch fail** — `cd packages/core && bun test test/permission/pipeline.test.ts` (module missing).
- [ ] **Step 3: Implement** — `plugins.ts` (consultor registry), `pipeline.ts` (orchestrator composing Tasks 2/4 pieces + existing evaluation; keep review/consultor callbacks before `create`), then modify `permission.ts` `ask`/`assert` to call `ApprovalPipeline.Service` (obtained via `Effect.context`/service yield inside the same layer — the pipeline lives in the permission layer's dependency graph). Modify `Decision.approvalSource` in `packages/schema/src/permission.ts`. In `plugin/index.ts` register the consultor at plugin load (inside the existing hooks assembly loop, after hooks are collected) and add `PolicyConsultors.node` to the plugin node deps. Follow repo style: happy path first, helpers below, no `else`, `const` over `let`.
- [ ] **Step 4: Run, watch pass** — core pipeline suite + opencode plugin-hook suite.
- [ ] **Step 5: Regenerate the client** — `cd packages/client && bun run generate` (Decision schema change). Do not hand-edit generated files.
- [ ] **Step 6: Typecheck** — `cd packages/schema && bun typecheck`, `cd packages/core && bun typecheck`, `cd packages/opencode && bun typecheck`.
- [ ] **Step 7: Commit** — `feat(core): unified approval pipeline with policy, review lane, and wired permission.ask consultors`.

---

### Task 8: Provenance ledger entry + regeneration + full verification

**Files:**
- Create: `docs/provenance/sources.json`
- Create: `docs/provenance/ledger.json`
- Modify: `TODO/README.md` (§7 Cross-Run Interface Registry row for RUN-06 — only if all produced interfaces landed as declared)
- No production code.

**Interfaces:**
- Consumes: `scripts/provenance/validate.ts` contract (fields it validates). Codex source of record pinned at `/home/thymia/UltraCode-Planning/codex` commit `0a0ebb85355113610dd3f7a3d8b36f68c33465fc`.

- [ ] **Step 1: Write the failing check** — run `bun run scripts/provenance/validate.ts` from repo root; expect `ERROR: missing file: docs/provenance/sources.json` (and ledger). This is the red.
- [ ] **Step 2: Create `docs/provenance/sources.json`**

```json
[
  {
    "id": "codex",
    "repo_path": "../codex",
    "remote_url": "https://github.com/openai/codex",
    "branch": "main",
    "pinned_commit": "0a0ebb85355113610dd3f7a3d8b36f68c33465fc",
    "license_spdx": "Apache-2.0",
    "license_file": "LICENSE",
    "notice_file": null,
    "authorization_ref": null,
    "history_available": true
  }
]
```

- [ ] **Step 3: Create `docs/provenance/ledger.json`**

```json
{
  "version": 1,
  "imports": [
    {
      "id": "run-06-approval-pipeline",
      "source_id": "codex",
      "original_path": "codex-rs/core/src/{exec_policy.rs,guardian/,command_canonicalization.rs}",
      "destination": "packages/core/src/permission/*",
      "treatment": "reimplement",
      "owner": "RUN-06",
      "imported_from_commit": "0a0ebb85355113610dd3f7a3d8b36f68c33465fc",
      "license_spdx": "Apache-2.0",
      "notice_required": false,
      "authorization_ref": null,
      "imported_at": "2026-08-06",
      "local_modifications": [],
      "upstream_merge_owner": "RUN-06"
    }
  ]
}
```

  The entry is a design-reimplementation record (JSON policy engine, review lane, amendment blocklist are TS reimplementations, no text copied). No authorization file is required because `license_spdx` is set and treatment is `reimplement`.

- [ ] **Step 4: Run the validator** — `bun run scripts/provenance/validate.ts` from repo root → `PROVENANCE OK: sources=1 imports=1 warnings=0`.
- [ ] **Step 5: Registry row** — append to `TODO/README.md` §7: `| RUN-06 | ApprovalPipeline + Decision.Record + RoleModels.Service | packages/core/src/permission/{pipeline,policy,review,amend,plugins}.ts, packages/schema/src/decision.ts, packages/core/src/agent/roles.ts | RUN-08, RUN-09, RUN-13, RUN-14 |`. Verify each produced symbol exists at its declared path.
- [ ] **Step 6: Full verification** — run every DoD command (§Definition of Done above) fresh; `git status` clean; every change committed on `approval-pipeline`.
- [ ] **Step 7: Commit** — `docs(provenance): ledger entries for run-06 approval pipeline reimplementation`.

---

## Run-Level Review Prompt (dispatch after Task 8)

```
Review the commits <list hashes> in /home/thymia/UltraCode-Planning/opencode
implementing RUN-06 (file: opencode/TODO/RUN-06-approval-pipeline.md).
Run-specific checks:
1. One owner: ApprovalPipeline is the only verdict path; grep the diff for any
   second approval decision site. Leaves still call PermissionV2.ask/assert,
   which delegate into the pipeline.
2. Deny-by-default preserved: unresolvable agents still resolve to
   [{action:"*",resource:"*",effect:"deny"}]; no policy/review/plugin path can
   broaden a configured deny (Task 1 characterization suite stays green).
3. Never fail open: review failure routes to a user prompt (fail to user);
   assert no branch auto-allows on ReviewLaneError.
4. Loop guard: the review lane and consultors never yield PermissionV2.Service
   or ApprovalPipeline.Service; grep review.ts and plugins.ts for a
   PermissionV2/ApprovalPipeline import — must be absent.
5. Dead hook wired: `permission.ask` is now triggered in plugin/index.ts; its
   verdicts are journaled with approvalSource "plugin" (or the Task 1 decision
   record says otherwise and the Deviation Log explains).
6. Provenance: `bun run scripts/provenance/validate.ts` prints PROVENANCE OK;
   no code text from ../codex is present in the diff (reimplementation only).
7. Decision system: `Question` options enforce maxItems(4); Decision.Record is
   the shared type for question and plan_exit; generated client regenerated,
   not hand-edited.
8. Role config: agentRoles + permission.reviewModel resolve explicit > role >
   session; scheduler child spawn and compaction consume the resolver.
9. Diff scope: only files declared across the run's task Files blocks.
Then the generic checks from TODO/README.md §5.1 items 1-5.
Reply numbered findings, BLOCKER or MINOR, file:line. No edits.
```

## Deviation Log (fill during execution)

| Task | Deviation | Reason |
|---|---|---|
| | | |
