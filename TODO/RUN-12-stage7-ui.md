# RUN-12: Stage 7 Completion — Authority Surfaces, Artifact Browsing, i18n, Packaging Blockers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the app command center's authoritative surfaces (inspector projections, artifact browsing, paged task accumulation, durable cancellation to live children), add the five-scenario authenticated e2e coverage, and unblock the known Arabic i18n parity and Bun arm64 extraction failures.

**Architecture:** The command center keeps fetching `/experimental/authority/*` through its raw `authority()` helper, but the server handlers stop being event-filter placeholders and become authoritative bounded projections: plugin inventory from `Bundle.Service.list()`, provider compatibility from the model catalog + `SessionRunnerModel.supported` + capability profiles, context/token/cache/cost from the RUN-05 diagnostics read API. `cancelTask` routes through `TaskSchedulerAdapter.cancel` so durable journal requests dispatch to live `SessionExecution.interrupt` children (RUN-01 projection). Task lists accumulate pages in the virtualized store instead of replacing them, and task roots are discoverable from a new `list_roots` sidecar projection. The app's data layer grows pure, tested reducer/projection functions; UI behavior is verified with Playwright against the existing mock-server harness.

**Tech Stack:** Bun, TypeScript, SolidJS (`@tanstack/solid-virtual`), Effect-TS (`HttpApi`), Rust (sidecar `crates/ultracode-events`, cargo), Playwright (`packages/app`), vite.

**Audit basis:** §20.8 (spend/cache illumination in the command center's diagnostics), §22 Stage 7 (merge three inspector projections; demote un-wired surfaces; add cache-hit/cost to diagnostics now), §22 Stage 7 Follow-Up (cancellation dispatch, artifact browsing, paged accumulation, authenticated e2e, i18n/arm64 jump-queue), §6 T6, §11.11.

## Global Constraints

All constraints in `TODO/README.md` §2 apply verbatim. In addition:

- **Branch:** `stage7-ui` (≤3 hyphenated words, no slashes, no type prefix). Create it from the current base before Task 1: `git checkout -b stage7-ui`.
- **Dependency gate:** RUN-12 consumes RUN-01 (cancellation projection, sidecar read APIs) and RUN-05 (diagnostics API). README §1 — never start Task 1 until both are DONE in the ledger. Task 2 additionally requires the RUN-05 run file to exist; if it does not, **STOP Task 2** and record a ledger blocker.
- **Stability > simplicity > performance (`packages/app/AGENTS.md`):** this run touches the command center only. Do **not** touch timeline/session code. A production benchmark baseline is required only for session/timeline changes; none is required here, but no new `createEffect` may be added to the command center — use `createResource`/`createStore` as the existing component does.
- **Do NOT modify `packages/app/src/components/session/session-header.tsx`** or any session-timeline file. "Task-root discovery from the normal app shell" is delivered inside the command center surface (a roots dropdown), which is already reachable from the shell route `/:dir/command-center` (`packages/app/src/app.tsx:629`).
- **Rust rule (mirrors RUN-01):** additions only to `crates/ultracode-events`; no semantic changes to existing RPCs or transition tables. Rust tests run from repo root: `cargo test -p ultracode-events`, `cargo clippy -p ultracode-events -- -D warnings`.
- **No hand-editing generated files:** if any change touches the public Server `HttpApi` schema, run `bun run generate` from `packages/client`; never edit `packages/client/src/generated*`.
- **i18n source of truth:** `packages/app/src/i18n/en.ts` (and `ui`/`desktop` `en.ts`) are read-only. Backfill translations with the sanctioned `bun run translate:app` tool or hand-fill only the exact missing keys. Never "improve" English copy.
- **Tests:** run from the owning package directory (never repo root). App: `cd packages/app && bun test <file>` + `bun typecheck` (`tsgo -b`). opencode: `cd packages/opencode && bun test <file>` + `bun typecheck`. events-client: `cd packages/ultracode-events-client && bun test` + `bun typecheck`. e2e: `cd packages/app && bunx playwright test <spec>`.

## Orchestrator Brief

### Context Files (read in full before dispatching Task 1)

1. `packages/app/src/components/command-center/command-center.tsx` (full) — current tabs, resources, virtualizer, `authority()` helper.
2. `packages/app/src/components/command-center/command-center-model.ts` + `command-center-model.test.ts` — the data layer to extend.
3. `packages/opencode/src/server/routes/instance/httpapi/groups/authority.ts` + `handlers/authority.ts` — the endpoint declarations and the placeholder handlers to replace.
4. `packages/opencode/src/agent/scheduler-service.ts` (full) — `ReadApi`, `createReadApi`, `SchedulerClient`/`ReadClient` Picks.
5. `packages/opencode/src/agent/scheduler.ts` (full) — `createTaskSchedulerAdapter` (`schedule`/`cancel`), `createChildSessionAdapter.cancel` → `execution.interrupt`, `finalize` terminal projection.
6. `packages/opencode/src/tool/task.ts` lines 19–70 — `TaskSchedulerAdapter` interface (`cancel` returns `Cancellation`).
7. `packages/ultracode-events-client/src/index.ts` (full) — RPC methods + wire types (`TaskRecord`, `TaskGraphPage`, `ArtifactRef`, `ArtifactMetadata`, `TaskDeliverable`, `ApprovalHistoryPage`).
8. `packages/ultracode-agents/src/scheduler.ts` — `createScheduler` client surface (RUN-01 produced).
9. `crates/ultracode-events/src/projections.rs` — `list_tasks` + `query_task_graph` (keyset cursor pattern) to mirror for `list_roots`; `crates/ultracode-events/src/rpc.rs` — the `"query_task_graph"` dispatch arm to mirror.
10. `packages/core/src/plugin/bundle.ts` (full) — `Bundle.Service.list(): Effect<PluginBundleInfo[], never>`; `packages/core/src/plugin.ts` — `PluginV2.node`.
11. `packages/core/src/session/runner/model.ts` (full) — `supported(model)`, error types, catalog resolution.
12. `packages/ultracode-schema/src/capability/profile.ts` — `resolveProfile`, `CapabilityProfile`, `CONSERVATIVE_PROFILE`.
13. `packages/app/e2e/utils/mock-server.ts` (full) + `packages/app/e2e/regression/command-center.spec.ts` + `packages/app/playwright.config.ts`.
14. `packages/app/src/i18n/parity.test.ts` + `script/translate-app.ts` + `script/translate-app.md`.
15. `install` (repo-root shell script) + `packages/opencode/script/postinstall.mjs` + `packages/opencode/script/build.ts` + `.github/workflows/publish.yml` (target matrix) + `packages/opencode/test/installation/installation.test.ts`.
16. `TODO/README.md` §3 (Exploration Protocol), §5 (Review Prompts), §7 (Cross-Run Interface Registry), §8 (Run Ledger). RUN-01's run-level review prompt for the sidecar "additions only" rule.

### Baselines (record before Task 1)

```bash
cd packages/app && bun test src/components/command-center/command-center-model.test.ts 2>&1 | tail -5
cd packages/app && bun test src/i18n/parity.test.ts 2>&1 | tail -15   # EXPECTED: FAILS (parity drift; this is the baseline to fix)
cd packages/app && bun typecheck
cd packages/opencode && bun test test/agent 2>&1 | tail -5
cd packages/opencode && bun typecheck
cd packages/ultracode-events-client && bun test 2>&1 | tail -5
cargo test -p ultracode-events 2>&1 | tail -5
```

### Dispatch Order

Tasks 1 → 8 strictly sequential. Task 2 depends on the RUN-05 diagnostics API; Task 4 adds the sidecar `list_roots` RPC (Rust) — dispatch Task 4 only after Task 3 is merged so the sidecar client additions land last within the run's Rust surface.

### Definition of Done (verify each with a command you ran)

- [ ] `appendTaskPage` accumulates and dedupes paged task graphs; `command-center-model.test.ts` green (`cd packages/app && bun test src/components/command-center/command-center-model.test.ts`).
- [ ] Inspector tabs show authoritative data, not filtered replays: `GET /experimental/authority/plugin-bundles` returns `Bundle.Service.list()` output; `GET /experimental/authority/providers` returns catalog rows with `supported` + resolved profile; `GET /experimental/authority/sessions/:id/context` returns the RUN-05 diagnostics snapshot. Verified by curl against a running server and by the server tests.
- [ ] Artifact tab browses deliverables → metadata (`statArtifact`) → bounded `openRange` with an out-of-range error surface (`GET /experimental/authority/tasks/:rootId/deliverables` + `/artifacts/:id` + `/artifacts/:id/range`).
- [ ] Task list accumulates pages (dedupe, stable sort) and `GET /experimental/authority/roots` powers a root dropdown in the command center.
- [ ] `POST /experimental/authority/tasks/:rootId/cancel` dispatches to the live child via `TaskSchedulerAdapter.cancel` (recorder test proves `interrupt` fired) and the graph refetch shows the terminal `cancelled` state.
- [ ] `bunx playwright test e2e/regression/command-center-authority.spec.ts` passes for cancellation, pagination, artifact ranges, approvals, and mobile progressive disclosure; the pre-existing `command-center.spec.ts` still passes.
- [ ] `packages/app/src/i18n/parity.test.ts` passes under `CI=true` and no longer skips (`grep -n "skipIf" packages/app/src/i18n/parity.test.ts` → no match).
- [ ] The installer arch-support test passes (`cd packages/opencode && bun test test/installation`), `install` accepts every arch combo `build.ts` produces, and the root cause is documented in `docs/`.
- [ ] `bun typecheck` passes in `packages/app`, `packages/opencode`, `packages/ultracode-events-client`; `cargo test -p ultracode-events` + `cargo clippy -p ultracode-events -- -D warnings` green.
- [ ] `git status` clean; branch is `stage7-ui`; TODO/README.md §8 run ledger row appended by the orchestrator.

---

### Task 1: Characterize command-center data layer, authority surface, and e2e harness; pin with a data-layer test

**Files:**
- Modify: `packages/app/src/components/command-center/command-center-model.ts`
- Modify: `packages/app/src/components/command-center/command-center-model.test.ts`

**Interfaces:**
- Consumes: nothing external. This task produces the inventory the remaining tasks build on (documented in the task body, no code beyond the model).
- Produces:
  - `export type TaskPage = { tasks: CommandCenterTask[]; edges: unknown[]; next_cursor: string | null }`
  - `export function appendTaskPage(accumulated: readonly CommandCenterTask[] | undefined, page: TaskPage): CommandCenterTask[]` — dedupe by `task_id` (first occurrence wins), then stable-sort `depth` ascending, then `task_id` ascending. Returns the merged list; never mutates `accumulated`.
  - `export function nextCursor(current: string | null | undefined, pageNext: string | null): string | null` — `pageNext` wins when non-null, else `current`, else `null`.

- [ ] **Step 1: Read the inventory targets in full** (Context Files 1–3, 13). Record in your final message: the exact endpoint list the component hits today (9 endpoints under `/experimental/authority/*`), the placeholder handlers (`handlers/authority.ts` `context`/`providers`/`plugins` all filter `read.replay` by `event.kind.includes(...)`), the e2e harness pattern (`mockOpenCodeServer` intercepts the target port `4096`; the component's `authority()` helper goes through `server.url`), and the `command-center.spec.ts` pattern (navigate `/<dirBase64>/command-center`, assert `data-component="ultracode-command-center"`).

- [ ] **Step 2: Write the failing test** — append to `command-center-model.test.ts`:

```ts
import { appendTaskPage, nextCursor, type CommandCenterTask } from "./command-center-model"

const task = (id: string, depth: number, state = "running"): CommandCenterTask => ({
  task_id: id,
  parent_task_id: depth === 0 ? null : "root",
  depth,
  state,
})

test("appendTaskPage dedupes by task_id and keeps the first occurrence's depth", () => {
  const page1 = { tasks: [task("b", 1), task("a", 0)], edges: [], next_cursor: "c1" }
  const page2 = { tasks: [task("a", 3), task("c", 2)], edges: [], next_cursor: null }
  const merged = appendTaskPage(page1.tasks, page2)
  expect(merged.map((t) => t.task_id)).toEqual(["a", "b", "c"])
  expect(merged.find((t) => t.task_id === "a")?.depth).toBe(0)
})

test("appendTaskPage starts empty and never mutates the accumulated array", () => {
  const page = { tasks: [task("a", 0)], edges: [], next_cursor: null }
  const first = appendTaskPage(undefined, page)
  const second = appendTaskPage(first, page)
  expect(second).toHaveLength(1)
  expect(first).not.toBe(second)
})

test("nextCursor prefers the page cursor then falls back to the accumulated cursor", () => {
  expect(nextCursor("c0", "c1")).toBe("c1")
  expect(nextCursor("c0", null)).toBe("c0")
  expect(nextCursor(undefined, null)).toBeNull()
})
```

- [ ] **Step 3: Run it, watch it fail**

Run: `cd packages/app && bun test src/components/command-center/command-center-model.test.ts`
Expected: FAIL — `appendTaskPage`/`nextCursor` are not exported.

- [ ] **Step 4: Write minimal implementation** — append to `command-center-model.ts` below the existing `flattenTaskGraph` (repo style: happy path on top, no `else`, dot notation, `const`):

```ts
export type TaskPage = { tasks: CommandCenterTask[]; edges: unknown[]; next_cursor: string | null }

export function appendTaskPage(
  accumulated: readonly CommandCenterTask[] | undefined,
  page: TaskPage,
): CommandCenterTask[] {
  const seen = new Set<string>()
  const merged = [...(accumulated ?? [])]
  for (const task of page.tasks) {
    if (seen.has(task.task_id)) continue
    seen.add(task.task_id)
    merged.push(task)
  }
  return merged.sort((a, b) => a.depth - b.depth || a.task_id.localeCompare(b.task_id))
}

export function nextCursor(current: string | null | undefined, pageNext: string | null): string | null {
  return pageNext ?? current ?? null
}
```

- [ ] **Step 5: Run test, watch it pass** — same command as Step 3. Expected: 4 pass (1 existing + 3 new).

- [ ] **Step 6: Typecheck** — `cd packages/app && bun typecheck`

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/components/command-center/command-center-model.ts packages/app/src/components/command-center/command-center-model.test.ts
git commit -m "test(app): pin command center data layer with page accumulation reducers"
```

---

### Task 2: Inspector projections wired to authoritative data (plugins, provider compat, context/token) + server read routes

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/authority.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/authority.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts` (location node wiring only)
- Modify: `packages/app/src/components/command-center/command-center-model.ts`
- Modify: `packages/app/src/components/command-center/command-center.tsx`
- Test: `packages/opencode/test/server/httpapi-authority.test.ts`
- Test: `packages/app/src/components/command-center/command-center-model.test.ts`

**Interfaces:**
- Consumes: `Bundle.Service.list(): Effect<PluginBundleInfo[], never>` (`packages/core/src/plugin/bundle.ts`); `SessionRunnerModel.supported(model)` + `Catalog.Service` (`packages/core/src/session/runner/model.ts`); `resolveProfile`/`CapabilityProfile` from `@ultracode/schema/capability`; **RUN-05 diagnostics read API** — exact signature lives in `TODO/RUN-05-*.md` (see Step 2 gate).
- Produces:
  - Server: `HttpApiEndpoint.get("pluginBundles", `${root}/plugin-bundles`, { query: AuthorityPageQuery, success: Schema.Unknown })`; `HttpApiEndpoint.get("providerCompat", `${root}/providers`, ...)` **replaces** the existing `providers` endpoint semantics (path unchanged, response shape becomes `ProviderCompatRow[]`); the `context` and `plugins` handlers stop filtering replays.
  - Wire type (server response, `Schema.Unknown`): `ProviderCompatRow = { providerID: string; modelID: string; api: string; supported: boolean; profileFamily: string; contextTokens: number }`.
  - App model (structural, no cross-package imports): `export type PluginBundleRow = { id: string; version: string; source: string; startup: string; status: string; health: string | null }`, `export function projectPluginBundles(info: readonly PluginBundleInfoLike[]): PluginBundleRow[]`, `export type ProviderCompatRow = { providerID: string; modelID: string; api: string; supported: boolean; profileFamily: string; contextTokens: number }`, `export function projectProviderCompat(models: readonly ProviderModelInfoLike[]): ProviderCompatRow[]` where `ProviderModelInfoLike = { providerID: string; id: string; api: { type: string }; }` (the app maps only the fields it renders).
  - `PluginBundleInfoLike = { manifest: { id: string; version: string; provenance: { source: string }; startup: string }; status: string; health?: { message: string } }`.

- [ ] **Step 1: Write the failing app-side projection tests** — append to `command-center-model.test.ts`:

```ts
import { projectPluginBundles, projectProviderCompat } from "./command-center-model"

test("projectPluginBundles maps manifest/status/health to bounded rows", () => {
  const rows = projectPluginBundles([
    { manifest: { id: "p1", version: "1.0.0", provenance: { source: "npm" }, startup: "optional" }, status: "active" },
    { manifest: { id: "p2", version: "2.0.0", provenance: { source: "path" }, startup: "lazy" }, status: "failed", health: { message: "Bundle activation failed" } },
  ])
  expect(rows).toEqual([
    { id: "p1", version: "1.0.0", source: "npm", startup: "optional", status: "active", health: null },
    { id: "p2", version: "2.0.0", source: "path", startup: "lazy", status: "failed", health: "Bundle activation failed" },
  ])
})

test("projectProviderCompat marks unsupported APIs and resolves conservative profile defaults", () => {
  const rows = projectProviderCompat([
    { providerID: "anthropic", id: "claude", api: { type: "aisdk:anthropic" }, supported: true },
    { providerID: "custom", id: "model-x", api: { type: "aisdk:openai-compatible" }, supported: false },
  ])
  expect(rows).toEqual([
    { providerID: "anthropic", modelID: "claude", api: "aisdk:anthropic", supported: true, profileFamily: "generic", contextTokens: 8192 },
    { providerID: "custom", modelID: "model-x", api: "aisdk:openai-compatible", supported: false, profileFamily: "generic", contextTokens: 8192 },
  ])
})
```

- [ ] **Step 2: Verify the RUN-05 diagnostics gate** — open `TODO/RUN-05-*.md` and copy the exact produced signature of its diagnostics read API into the task's `Interfaces: Consumes`. If the RUN-05 file does not exist or exposes no diagnostics read API, **STOP this task**, do not fabricate a route, and report a ledger blocker (README §9). The `context` endpoint's handler in this task MUST call that API. If RUN-05 exists and its shape differs from this plan's expectation, code wins — update the excerpt and record the deviation.

- [ ] **Step 3: Run app tests, watch them fail**

Run: `cd packages/app && bun test src/components/command-center/command-center-model.test.ts`
Expected: FAIL — `projectPluginBundles`/`projectProviderCompat` not exported.

- [ ] **Step 4: Implement the app projections** — append to `command-center-model.ts`:

```ts
export type PluginBundleRow = {
  id: string
  version: string
  source: string
  startup: string
  status: string
  health: string | null
}

export function projectPluginBundles(info: readonly PluginBundleInfoLike[]): PluginBundleRow[] {
  return info.map((bundle) => ({
    id: bundle.manifest.id,
    version: bundle.manifest.version,
    source: bundle.manifest.provenance.source,
    startup: bundle.manifest.startup,
    status: bundle.status,
    health: bundle.health?.message ?? null,
  }))
}

export type ProviderCompatRow = {
  providerID: string
  modelID: string
  api: string
  supported: boolean
  profileFamily: string
  contextTokens: number
}

export function projectProviderCompat(models: readonly ProviderModelInfoLike[]): ProviderCompatRow[] {
  return models.map((model) => ({
    providerID: model.providerID,
    modelID: model.id,
    api: model.api.type,
    supported: model.supported,
    profileFamily: "generic",
    contextTokens: 8192,
  }))
}
```

(If RUN-05's capability profiles are resolvable in the app domain, pass the resolved `CapabilityProfile` in `ProviderModelInfoLike` and use `profile.family`/`profile.contextTokens` instead of the conservative defaults; otherwise the defaults above are the bounded projection. Keep the wire shape identical.)

- [ ] **Step 5: Write the failing server test** — create `packages/opencode/test/server/httpapi-authority.test.ts`. Reuse the repo's shared route harness (`test/server/httpapi-layer.ts`: `httpApiLayer` serves the full `HttpApiApp.routes` on `NodeHttpServer.layerTest`, with `requestInDirectory` adding the `x-opencode-directory` header). Override the three boundaries you are not exercising with `Layer.mock` (endorsed by `test/server/AGENTS.md`):

```ts
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SchedulerService } from "@/agent/scheduler-service"
import { Bundle } from "@opencode-ai/core/plugin/bundle"
import { Catalog } from "@opencode-ai/core/catalog"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const authorityLayer = (scheduler: Partial<SchedulerService.Interface>) =>
  httpApiLayer.pipe(
    Layer.provideMerge(Layer.mock(SchedulerService.Service, scheduler)),
    Layer.provideMerge(
      Layer.mock(Bundle.Service, {
        list: () =>
          Effect.succeed([
            {
              manifest: { id: "p1", version: "1.0.0", provenance: { source: "npm", location: "/x" }, permissions: [], startup: "optional", contributions: {} },
              status: "active",
            },
          ]),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(Catalog.Service, {
        model: {
          default: () => Effect.fail(new Error("unused")),
          available: () =>
            Effect.succeed([
              { providerID: "anthropic", id: "claude", api: { type: "aisdk:anthropic" } },
              { providerID: "custom", id: "model-x", api: { type: "aisdk:openai-compatible" } },
            ]),
        },
        provider: { get: () => Effect.fail(new Error("unused")) },
      }),
    ),
  )

describe("authority inspector projections", () => {
  const it = testEffect(authorityLayer({ read: () => Effect.fail(new Error("unused")) }))

  it.instance("plugin-bundles returns Bundle.Service.list() output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const response = yield* requestInDirectory("/experimental/authority/plugin-bundles", test.directory)
      const body = yield* response.json
      expect(body[0].manifest.id).toBe("p1")
      expect(body[0].status).toBe("active")
    }),
  )

  it.instance("providers returns catalog rows with supported flags", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const response = yield* requestInDirectory("/experimental/authority/providers", test.directory)
      const body = yield* response.json
      expect(body).toEqual([
        { providerID: "anthropic", modelID: "claude", api: "aisdk:anthropic", supported: true, profileFamily: "generic", contextTokens: 8192 },
        { providerID: "custom", modelID: "model-x", api: "aisdk:openai-compatible", supported: false, profileFamily: "generic", contextTokens: 8192 },
      ])
    }),
  )
})
```

Adjust the `Catalog.Service` mock to the real interface shape read from `packages/core/src/catalog` (the shape above follows `model.ts` usage `catalog.model.available()`/`catalog.provider.get(...)`); if the interface differs, code wins. The `profileFamily`/`contextTokens` fields must match whatever the `providers` handler emits after Task 2 Step 6 is implemented — keep the handler and the test in sync.

- [ ] **Step 6: Implement the server handlers + endpoint + wiring**

In `groups/authority.ts` add `pluginBundles` and keep `providers` (path unchanged):

```ts
HttpApiEndpoint.get("pluginBundles", `${root}/plugin-bundles`, { query: AuthorityPageQuery, success: Schema.Unknown }),
```

In `handlers/authority.ts`, yield the new services once at group build and replace the three placeholder handlers:

```ts
const bundles = yield* Bundle.Service
const catalog = yield* Catalog.Service

.handle("pluginBundles", () => bundles.list())
.handle("providers", () =>
  Effect.gen(function* () {
    const models = yield* catalog.model.available()
    return models.map((model) => ({
      providerID: model.providerID,
      modelID: model.id,
      api: model.api.type,
      supported: SessionRunnerModel.supported(model),
      profileFamily: "generic",
      contextTokens: 8192,
    }))
  }),
)
.handle("context", (ctx) => read.diagnostics({ session: ctx.params.sessionId, sinceSeq: ctx.query.sinceSeq, limit: page(ctx.query) }))
```

`providers` emits the full `ProviderCompatRow` (with the conservative profile defaults for now; if RUN-05 exposes per-model resolved profiles, replace the defaults with `profile.family`/`profile.contextTokens`). The `context` handler calls the RUN-05 diagnostics read API — the exact method name on `read` is whatever RUN-05 produced (Step 2); if RUN-05 places it elsewhere, adapt and record the deviation. Wire `Bundle.node` + `PluginV2.node` (`@opencode-ai/core/plugin`) into the server's location node group in `server.ts` beside `Plugin.node` (opencode-side plugin is a different service; both are needed).

- [ ] **Step 7: Run server test, watch it pass** — `cd packages/opencode && bun test test/server/httpapi-authority.test.ts`. Then `bun typecheck`.

- [ ] **Step 8: Wire the app inspector tabs** — in `command-center.tsx`:
  - Replace the `plugins` resource with `authority<PluginBundleRow[]>(server(), "/experimental/authority/plugin-bundles", { directory: sdk().directory })` and render `projectPluginBundles(...)` rows (id, version, status badge, health message).
  - Replace the `providers` resource with `authority<ProviderCompatRow[]>(server(), "/experimental/authority/providers", query())` and render provider/model rows with a supported/compat indicator (the server emits full `ProviderCompatRow`s; the app's `projectProviderCompat` stays as the tested data-layer normalizer for the same wire shape).
  - Keep the `context` resource on `/sessions/:id/context` but render the diagnostics snapshot fields (context blocks, token totals, cache-hit rate, cost) when present.
  - Move the `EventPanel`/`State` rendering only within the command-center files; do not add `createEffect`.

- [ ] **Step 9: App test + typecheck** — `cd packages/app && bun test src/components/command-center/command-center-model.test.ts && bun typecheck`.

- [ ] **Step 10: Commit**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/groups/authority.ts packages/opencode/src/server/routes/instance/httpapi/handlers/authority.ts packages/opencode/src/server/routes/instance/httpapi/server.ts packages/opencode/test/server/httpapi-authority.test.ts packages/app/src/components/command-center/command-center-model.ts packages/app/src/components/command-center/command-center-model.test.ts packages/app/src/components/command-center/command-center.tsx
git commit -m "feat(opencode): serve authoritative inspector projections over authority routes"
```

---

### Task 3: Artifact browser (deliverable list + metadata + bounded range reads with error UX)

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/authority.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/authority.ts`
- Modify: `packages/app/src/components/command-center/command-center-model.ts`
- Modify: `packages/app/src/components/command-center/command-center.tsx`
- Test: `packages/app/src/components/command-center/command-center-model.test.ts`
- Test: `packages/opencode/test/server/httpapi-authority.test.ts`

**Interfaces:**
- Consumes: `ReadApi.deliverables` and `ReadApi.artifact`/`ReadApi.artifactRange` (RUN-01 produced, `scheduler-service.ts:52-55`); `TaskDeliverablePage`/`ArtifactRef` wire shapes (`ultracode-events-client/src/index.ts:74-83`, `:15`).
- Produces:
  - Server: `HttpApiEndpoint.get("deliverables", `${root}/tasks/:rootId/deliverables`, { params: { rootId: Schema.String }, query: AuthorityPageQuery, success: Schema.Unknown })` → handler `read.deliverables({ rootId, workspaceDirectory: directory, cursor, limit: page(query) })`.
  - App model: `export type DeliverablePage = { items: TaskDeliverable[]; next_cursor: string | null }`, `export type TaskDeliverable = { root_id: string; task_id: string; status: string; summary: string; artifact_ids: string[]; changed_paths: string[]; test_summary: string | null }`, `export type ArtifactRef = { artifact_id: string; mime: string; byte_length: number; hash: string }`, `export type RangeWindow = { start: number; end: number; overflow: boolean }`, `export function collectArtifactRefs(pages: readonly DeliverablePage[]): ArtifactRef[]` (dedupe by `artifact_id`), `export function clampRange(byteLength: number, start: number | undefined, end: number | undefined): RangeWindow`.

- [ ] **Step 1: Write the failing app tests** — append to `command-center-model.test.ts`:

```ts
import { collectArtifactRefs, clampRange } from "./command-center-model"

test("collectArtifactRefs flattens deliverable artifact ids and dedupes", () => {
  const pages = [
    { items: [{ root_id: "r", task_id: "a", status: "completed", summary: "s", artifact_ids: ["x1", "x2"], changed_paths: [], test_summary: null }], next_cursor: null },
    { items: [{ root_id: "r", task_id: "b", status: "completed", summary: "s", artifact_ids: ["x2"], changed_paths: [], test_summary: null }], next_cursor: null },
  ]
  expect(collectArtifactRefs(pages)).toEqual(["x1", "x2"])
})

test("clampRange bounds a requested window to byte_length and reports overflow", () => {
  expect(clampRange(100, 0, 65536)).toEqual({ start: 0, end: 100, overflow: true })
  expect(clampRange(100, undefined, undefined)).toEqual({ start: 0, end: 100, overflow: false })
  expect(clampRange(100, 90, 200)).toEqual({ start: 90, end: 100, overflow: true })
  expect(clampRange(100, 150, 200)).toEqual({ start: 100, end: 100, overflow: true })
})
```

- [ ] **Step 2: Run, watch fail** — `cd packages/app && bun test src/components/command-center/command-center-model.test.ts` → missing exports.

- [ ] **Step 3: Implement the app model functions** — append to `command-center-model.ts`:

```ts
export type TaskDeliverable = {
  root_id: string
  task_id: string
  status: string
  summary: string
  artifact_ids: string[]
  changed_paths: string[]
  test_summary: string | null
}

export type DeliverablePage = { items: TaskDeliverable[]; next_cursor: string | null }

export type ArtifactRef = { artifact_id: string; mime: string; byte_length: number; hash: string }

export type RangeWindow = { start: number; end: number; overflow: boolean }

export function collectArtifactRefs(pages: readonly DeliverablePage[]): ArtifactRef[] {
  const seen = new Set<string>()
  const refs: ArtifactRef[] = []
  for (const page of pages) {
    for (const item of page.items) {
      for (const artifactId of item.artifact_ids) {
        if (seen.has(artifactId)) continue
        seen.add(artifactId)
        refs.push({ artifact_id: artifactId, mime: "application/octet-stream", byte_length: 0, hash: "" })
      }
    }
  }
  return refs
}

export function clampRange(byteLength: number, start: number | undefined, end: number | undefined): RangeWindow {
  const from = Math.max(0, Math.min(start ?? 0, byteLength))
  const to = Math.min(end ?? byteLength, byteLength)
  const requested = end !== undefined && end > byteLength
  return { start: from, end: Math.max(from, to), overflow: requested }
}
```

(Artifact metadata is enriched later by `statArtifact`; `collectArtifactRefs` returns placeholder refs that the tab immediately re-hydrates via `/artifacts/:id`.)

- [ ] **Step 4: Add the server endpoint + test** — in `groups/authority.ts` add the `deliverables` endpoint; in `handlers/authority.ts` add the handler. In `test/server/httpapi-authority.test.ts` extend the `authorityLayer` helper so `read` is overridable, then add:

```ts
const it = testEffect(
  authorityLayer({
    read: () =>
      Effect.succeed({
        deliverables: ({ cursor }: { cursor?: string }) =>
          Promise.resolve(
            cursor
              ? { items: [], next_cursor: null }
              : {
                  items: [{ root_id: "root-a", task_id: "task-1", status: "completed", summary: "s", artifact_ids: ["x1"], changed_paths: [], test_summary: null }],
                  next_cursor: "c1",
                },
          ),
      }),
  }),
)

it.instance("deliverables pages a root's task deliverables", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const response = yield* requestInDirectory("/experimental/authority/tasks/root-a/deliverables", test.directory)
    const body = yield* response.json
    expect(body.items[0].artifact_ids).toEqual(["x1"])
    expect(body.next_cursor).toBe("c1")
  }),
)
```

(`read` is a `Partial<ReadApi>`; the mock's unused methods throw `UnimplementedError` if accidentally called.)

- [ ] **Step 5: Run/pass server test** — `cd packages/opencode && bun test test/server/httpapi-authority.test.ts && bun typecheck`.

- [ ] **Step 6: Build the artifact tab UI** — in `command-center.tsx`:
  - New resource: `deliverables` over `/experimental/authority/tasks/${rootId}/deliverables` when a root is set (reuse the `tasks` source key); a "Load more artifacts" button appends pages via `collectArtifactRefs`.
  - Selecting an artifact sets `ui.artifactId`; metadata and range resources already exist — add a bounded window picker (preset `start`/`end`, default first 64 KiB) and render `clampRange(byte_length, start, end)`; when `overflow` or `statArtifact` returns `null` (404), show an inline `role="alert"` error ("Artifact not found" / "Range exceeds byte_length") instead of the raw bytes.
  - Do not add `createEffect`.

- [ ] **Step 7: App test + typecheck** — `cd packages/app && bun test src/components/command-center/command-center-model.test.ts && bun typecheck`.

- [ ] **Step 8: Commit**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/groups/authority.ts packages/opencode/src/server/routes/instance/httpapi/handlers/authority.ts packages/opencode/test/server/httpapi-authority.test.ts packages/app/src/components/command-center/command-center-model.ts packages/app/src/components/command-center/command-center-model.test.ts packages/app/src/components/command-center/command-center.tsx
git commit -m "feat(app): browse artifacts over paged deliverables with bounded range UX"
```

---

### Task 4: Paged task accumulation + task-root discovery (`list_roots` sidecar RPC)

**Files:**
- Modify: `crates/ultracode-events/src/projections.rs`
- Modify: `crates/ultracode-events/src/rpc.rs`
- Modify: `crates/ultracode-events/src/lib.rs` (only if `rpc.rs` needs a new struct export; prefer local structs)
- Modify: `packages/ultracode-events-client/src/index.ts`
- Modify: `packages/opencode/src/agent/scheduler-service.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/authority.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/authority.ts`
- Modify: `packages/app/src/components/command-center/command-center.tsx`
- Modify: `packages/app/src/components/command-center/command-center-model.ts`
- Test: `crates/ultracode-events/src/rpc.rs` (additive cargo test)
- Test: `packages/ultracode-events-client/test/roots.test.ts`
- Test: `packages/opencode/test/server/httpapi-authority.test.ts`
- Test: `packages/app/src/components/command-center/command-center-model.test.ts`

**Interfaces:**
- Consumes: `appendTaskPage`/`nextCursor` (Task 1); `TaskRecord`/`TaskGraphPage` shapes; the keyset-cursor pattern in `query_task_graph`.
- Produces:
  - Rust: `pub fn list_roots(&self, workspace_directory: &str, cursor: Option<&str>, limit: u64) -> Result<RootListPage, rusqlite::Error>`; `#[derive(serde::Serialize)] struct RootListPage { roots: Vec<RootRecord>, next_cursor: Option<String> }`; `struct RootRecord { root_id: String, task_id: String, state: String, updated_at: i64 }`; `struct RootListCursor { updated_at: i64, root_id: String }` (serde). RPC arm `"list_roots"` in `rpc.rs`.
  - Client (`packages/ultracode-events-client/src/index.ts`): `export type RootRecord = { root_id: string; task_id: string; state: string; updated_at: number }`, `export type RootsPage = { roots: RootRecord[]; next_cursor: string | null }`, `async listRoots(workspaceDirectory: string, cursor?: string, limit = 100): Promise<RootsPage>`.
  - Server: `ReadApi.roots` field + `createReadApi` mapping + `SchedulerClient`/`ReadClient` Pick additions (`scheduler-service.ts`); `HttpApiEndpoint.get("roots", `${root}/roots`, { query: AuthorityPageQuery, success: Schema.Unknown })` + handler.
  - App model: `export type RootRecord = { root_id: string; task_id: string; state: string; updated_at: number }`, `export function rootOptions(roots: readonly RootRecord[]): Array<{ value: string; label: string }>`.

- [ ] **Step 1: Write the failing Rust test** — append to the `query_task_graph` test block in `rpc.rs` (read the existing test helpers first; they drive the client via `make_client()`):

```rust
#[test]
fn list_roots_pages_distinct_roots_by_recency() {
    let (mut client, _dir) = make_client();
    // spawn two roots (depth 0, task_id == root_id) in the same workspace,
    // then assert list_roots returns both, newest first, and that a cursor
    // resumes after the first page.
    let roots = client.call("list_roots", json!({ "workspace_directory": "C:\\workspace", "limit": 1 }));
    let roots: serde_json::Value = roots.unwrap();
    assert_eq!(roots["roots"].as_array().unwrap().len(), 1);
    let cursor = roots["next_cursor"].as_str().unwrap();
    let second = client.call("list_roots", json!({ "workspace_directory": "C:\\workspace", "cursor": cursor, "limit": 1 }));
    let second: serde_json::Value = second.unwrap();
    assert_eq!(second["roots"].as_array().unwrap().len(), 1);
    assert_ne!(second["roots"][0]["root_id"], roots["roots"][0]["root_id"]);
}
```

(Mirror the existing `task-graph` test fixtures that spawn `root`/`child` tasks at lines ~1800 of `rpc.rs`; root rows are identified by `task_id = root_id AND depth = 0`.)

- [ ] **Step 2: Run, watch fail** — `cargo test -p ultracode-events` → `list_roots` RPC is unknown.

- [ ] **Step 3: Implement the Rust projection + RPC** — in `projections.rs`, mirror `query_task_graph` (keyset cursor, `limit + 1` has-more detection):

```rust
pub fn list_roots(
    &self,
    workspace_directory: &str,
    cursor: Option<&str>,
    limit: u64,
) -> Result<RootListPage, rusqlite::Error> {
    let limit = limit.min(200);
    let after = cursor
        .map(|value| serde_json::from_str::<RootListCursor>(value))
        .transpose()
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut stmt = self.conn.prepare(
        "SELECT root_id, task_id, state, updated_at FROM tasks \
         WHERE workspace_directory = ?1 AND task_id = root_id \
           AND (?2 IS NULL OR updated_at < ?2 OR (updated_at = ?2 AND root_id > ?3)) \
         ORDER BY updated_at DESC, root_id ASC LIMIT ?4",
    )?;
    let rows = stmt.query_map(
        params![
            workspace_directory,
            after.as_ref().map(|value| value.updated_at),
            after.as_ref().map(|value| value.root_id.as_str()),
            limit + 1
        ],
        |row| {
            Ok(RootRecord {
                root_id: row.get(0)?,
                task_id: row.get(1)?,
                state: row.get(2)?,
                updated_at: row.get(3)?,
            })
        },
    )?;
    let mut roots = rows.collect::<Result<Vec<_>, _>>()?;
    let has_more = roots.len() > limit as usize;
    if has_more {
        roots.pop();
    }
    let next_cursor = if has_more {
        roots.last().map(|root| {
            serde_json::to_string(&RootListCursor {
                updated_at: root.updated_at,
                root_id: root.root_id.clone(),
            })
            .expect("root cursor serializes")
        })
    } else {
        None
    };
    Ok(RootListPage { roots, next_cursor })
}
```

Add `RootRecord`/`RootListPage`/`RootListCursor` structs next to `TaskRecord`/`TaskPageCursor` in `projections.rs`, derive `serde::Serialize` (and `serde::Deserialize` for the cursor), and register the `"list_roots"` arm in `rpc.rs` mirroring the `"query_task_graph"` dispatch (decode params, call `projection.list_roots(...)`, serialize result).

- [ ] **Step 4: Run/pass Rust** — `cargo test -p ultracode-events` and `cargo clippy -p ultracode-events -- -D warnings`.

- [ ] **Step 5: Client + scheduler-service** — in `ultracode-events-client/src/index.ts` add the types and:

```ts
async listRoots(workspaceDirectory: string, cursor?: string, limit = 100): Promise<RootsPage> {
  return this.call("list_roots", {
    workspace_directory: workspaceDirectory,
    ...(cursor === undefined ? {} : { cursor }),
    limit,
  })
}
```

In `scheduler-service.ts`: add `listRoots` to `SchedulerClient` and `ReadClient` Picks; add `readonly roots: (input: { workspaceDirectory: string; cursor?: string; limit?: number }) => ReturnType<ReadClient["listRoots"]>` to `ReadApi`; map it in `createReadApi`. In `groups/authority.ts` add the `roots` endpoint; in `handlers/authority.ts`:

```ts
.handle("roots", (ctx) =>
  Effect.gen(function* () {
    const directory = yield* InstanceState.directory
    return yield* Effect.promise(() => read.roots({ workspaceDirectory: directory, cursor: ctx.query.cursor, limit: page(ctx.query) }))
  }),
)
```

- [ ] **Step 6: Client test** — create `packages/ultracode-events-client/test/roots.test.ts` using the in-memory `SidecarTransport` seam (`EventsClient.start` with a transport that records methods, mirroring existing client tests):

```ts
test("listRoots sends workspace_directory and resumes on cursor", async () => {
  const calls: Array<{ method: string; params: unknown }> = []
  const client = await start({ transport: async (method, params) => { calls.push({ method, params }); return { roots: [], next_cursor: null } } })
  await client.listRoots("C:\\workspace", "cursor-1", 50)
  expect(calls).toEqual([{ method: "list_roots", params: { workspace_directory: "C:\\workspace", cursor: "cursor-1", limit: 50 } }])
})
```

(Check the existing `start` signature and in-memory transport shape in `src/index.ts:109-138` and the existing tests; adapt the constructor call accordingly.)

- [ ] **Step 7: Server test** — in `test/server/httpapi-authority.test.ts`, add a `roots` test through the same `authorityLayer` helper (mock `read.roots` returning a scripted `RootsPage`), and assert `requestInDirectory("/experimental/authority/roots", test.directory)` returns `{ roots, next_cursor }`.

- [ ] **Step 8: App data layer + UI** — in `command-center-model.ts`:

```ts
export type RootRecord = { root_id: string; task_id: string; state: string; updated_at: number }

export function rootOptions(roots: readonly RootRecord[]): Array<{ value: string; label: string }> {
  return roots.map((root) => ({ value: root.root_id, label: `${root.root_id} (${root.state})` }))
}
```

In `command-center.tsx`: add a `roots` resource over `/experimental/authority/roots`; render a `<select aria-label="Task root">` of `rootOptions(...)` that sets `ui.rootId` on change (falling back to the existing text input when the select is empty). Change the tasks resource so "Load next page" uses `nextCursor(ui.cursor, next)` and **appends** via `appendTaskPage(taskRows(), page)` instead of replacing — keep the virtualizer's `count` derived from the accumulated list and preserve scroll position (the virtualizer keeps `scrollTop`; do not reset it on append).

- [ ] **Step 9: App test + typecheck** — append `rootOptions` and `appendTaskPage`-based accumulation tests to `command-center-model.test.ts`; `cd packages/app && bun test src/components/command-center/command-center-model.test.ts && bun typecheck`.

- [ ] **Step 10: Commit**

```bash
git add crates/ultracode-events/src/projections.rs crates/ultracode-events/src/rpc.rs packages/ultracode-events-client/src/index.ts packages/ultracode-events-client/test/roots.test.ts packages/opencode/src/agent/scheduler-service.ts packages/opencode/src/server/routes/instance/httpapi/groups/authority.ts packages/opencode/src/server/routes/instance/httpapi/handlers/authority.ts packages/opencode/test/server/httpapi-authority.test.ts packages/app/src/components/command-center/command-center.tsx packages/app/src/components/command-center/command-center-model.ts packages/app/src/components/command-center/command-center-model.test.ts
git commit -m "feat(opencode): discover scheduler task roots and accumulate paged task graphs"
```

---

### Task 5: Durable cancellation UX (live-child dispatch, terminal-outcome projection)

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/authority.ts`
- Modify: `packages/app/src/components/command-center/command-center.tsx`
- Modify: `packages/app/src/components/command-center/command-center-model.ts`
- Test: `packages/opencode/test/server/httpapi-authority.test.ts`
- Test: `packages/app/src/components/command-center/command-center-model.test.ts`

**Interfaces:**
- Consumes: `TaskSchedulerAdapter.cancel(input: { rootId: string; taskId: string; reason: string }): Effect<Cancellation, Error>` where `Cancellation.state: "cancelled" | "cancellation_pending"` (`packages/opencode/src/tool/task.ts:19-26`, implemented at `scheduler.ts:553-568`); RUN-01 `finalize` terminal projection.
- Produces:
  - Server: `cancelTask` handler now returns `{ state: "cancelled" | "cancellation_pending" }` produced by `scheduler.adapter.cancel` (live-child dispatch). The `AuthorityCancelPayload.idempotencyKey` field is kept in the schema for wire compatibility but is **ignored** — the adapter uses its canonical key `task:<rootId>:<taskId>:cancel`, so repeated UI clicks are idempotent.
  - App model: `export function cancelViewState(state: string | undefined, canceling: boolean): "idle" | "pending" | "terminal"` where `terminal` = `state` is `completed`/`failed`/`cancelled`.

- [ ] **Step 1: Write the failing server test** — add to `test/server/httpapi-authority.test.ts` a dedicated describe block (the `it.instance` registrations must live at describe-collection time, not inside another `test`):

```ts
describe("authority cancel", () => {
  const interrupts: string[] = []
  const it = testEffect(
    authorityLayer({
      adapter: () =>
        Effect.succeed({
          schedule: () => Effect.fail(new Error("unused")),
          cancel: ({ taskId }: { taskId: string }) => {
            interrupts.push(taskId)
            return Effect.succeed({ state: "cancellation_pending" as const })
          },
        }),
    }),
  )

  it.instance("dispatches through the scheduler adapter to live children", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const response = yield* requestInDirectory(
        "/experimental/authority/tasks/root-a/cancel",
        test.directory,
        { method: "POST", body: JSON.stringify({ taskId: "task-1", reason: "user", idempotencyKey: "ui-cancel:root-a:task-1" }) },
      )
      const body = yield* response.json
      expect(body.state).toBe("cancellation_pending")
      expect(interrupts).toEqual(["task-1"])
    }),
  )
})
```

(If the authority handler fails before `adapter.cancel` runs — e.g. the current `read.cancel` path — `interrupts` stays empty and the assertion fails.)

- [ ] **Step 2: Run, watch fail** — `cd packages/opencode && bun test test/server/httpapi-authority.test.ts`. Expected: the current handler calls `read.cancel` (raw sidecar RPC), so the recorder never fires.

- [ ] **Step 3: Implement the handler** — in `handlers/authority.ts` replace the `cancelTask` handler:

```ts
.handle("cancelTask", (ctx) =>
  Effect.gen(function* () {
    const adapter = yield* scheduler.adapter
    return yield* adapter.cancel({ rootId: ctx.params.rootId, taskId: ctx.payload.taskId, reason: ctx.payload.reason })
  }),
)
```

The adapter's `cancel` (`scheduler.ts:553`) journals `requestCancellation` with the canonical key, dispatches `child.cancel` → `SessionExecution.interrupt` for a live child, and returns `cancellation_pending`/`cancelled`; `finalize` commits the terminal `cancelled` deliverable (RUN-01). If the adapter errors (sidecar unavailable), the handler surfaces the error through the existing error path.

- [ ] **Step 4: Run/pass server test + typecheck** — `cd packages/opencode && bun test test/server/httpapi-authority.test.ts && bun typecheck`.

- [ ] **Step 5: App model + test** — append to `command-center-model.ts`:

```ts
export function cancelViewState(state: string | undefined, canceling: boolean): "idle" | "pending" | "terminal" {
  if (state === "completed" || state === "failed" || state === "cancelled") return "terminal"
  return canceling ? "pending" : "idle"
}
```

Append to `command-center-model.test.ts`:

```ts
import { cancelViewState } from "./command-center-model"

test("cancelViewState maps terminal and optimistic states", () => {
  expect(cancelViewState("running", false)).toBe("idle")
  expect(cancelViewState("running", true)).toBe("pending")
  expect(cancelViewState("cancelled", true)).toBe("terminal")
  expect(cancelViewState("failed", false)).toBe("terminal")
})
```

- [ ] **Step 6: Wire the cancel button** — in `command-center.tsx`:
  - Keep the existing `POST /tasks/:rootId/cancel` call with `{ taskId, reason, idempotencyKey: ui-cancel:... }` (the server ignores the key).
  - Optimistic state: `TaskRow` receives `pending = cancelViewState(task.state, ui.canceling === task.task_id)`; show a spinner/disabled button when `pending`, and keep the button disabled when `terminal` (the existing guard already covers the state).
  - After cancel resolves, `taskActions.refetch()` so the graph projects the confirmed terminal `cancelled` state; when `state: "cancelled"` renders, the row shows `cancelled` and the button stays disabled (terminal-outcome projection into the command center).

- [ ] **Step 7: App test + typecheck** — `cd packages/app && bun test src/components/command-center/command-center-model.test.ts && bun typecheck`.

- [ ] **Step 8: Commit**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/handlers/authority.ts packages/opencode/test/server/httpapi-authority.test.ts packages/app/src/components/command-center/command-center.tsx packages/app/src/components/command-center/command-center-model.ts packages/app/src/components/command-center/command-center-model.test.ts
git commit -m "feat(opencode): cancel durable tasks through live scheduler children"
```

---

### Task 6: Playwright e2e coverage for the five authority scenarios

**Files:**
- Modify: `packages/app/e2e/utils/mock-server.ts` (additive authority stubbing)
- Create: `packages/app/e2e/regression/command-center-authority.spec.ts`

**Interfaces:**
- Consumes: the command-center UI produced in Tasks 2–5; the `mockOpenCodeServer` harness (the "auth flow" — the app connects to the mocked server, `onConnectKey` handles provider auth).
- Produces: `MockServerConfig.authority?: AuthorityMock` (additive; defaults off, existing specs unaffected):

```ts
export type AuthorityMock = {
  taskPages: (input: { rootId: string; cursor?: string }) => { tasks: unknown[]; edges: unknown[]; next_cursor: string | null }
  roots?: () => { roots: unknown[]; next_cursor: string | null }
  approvals?: (input: { cursor?: string }) => { items: unknown[]; next_cursor: string | null }
  deliverables?: (input: { rootId: string; cursor?: string }) => { items: unknown[]; next_cursor: string | null }
  artifact?: (artifactId: string) => Record<string, unknown> | null
  artifactRange?: (input: { artifactId: string; start?: number; end?: number }) => { bytes: number[] }
  cancel?: (input: { rootId: string; taskId: string }) => { state: "cancelled" | "cancellation_pending" }
}
```

- [ ] **Step 1: Write the failing spec** — create `e2e/regression/command-center-authority.spec.ts` with five tests, all routing through `mockOpenCodeServer` (provide the `authority` config so `/experimental/authority/*` requests resolve on the target port). Follow the existing command-center spec's URL convention: `page.goto(\`/${base64Encode(directory)}/command-center\`)` with `directory` from a shared fixture (a `base64Encode` import like the smoke fixture uses). Tests:

```ts
test("cancels a running task and projects the terminal outcome", async ({ page }) => {
  let cancelBody: { taskId?: string; idempotencyKey?: string } | undefined
  let graphCalls = 0
  await mockOpenCodeServer(page, {
    sessions: [], provider: {}, directory, project,
    pageMessages: () => ({ items: [] }),
    authority: {
      taskPages: ({ rootId, cursor }) =>
        cursor
          ? { tasks: [{ task_id: "child", parent_task_id: "root", depth: 1, state: "cancelled" }], edges: [], next_cursor: null }
          : { tasks: [{ task_id: "root", parent_task_id: null, depth: 0, state: "running" }, { task_id: "child", parent_task_id: "root", depth: 1, state: "running" }], edges: [], next_cursor: null },
      cancel: ({ taskId }) => { cancelBody = { taskId }; return { state: "cancellation_pending" } },
    },
  })
  await page.goto(`/${base64Encode(directory)}/command-center`)
  // assert the two rows render, click the child row's cancel button,
  // then expect the child row's state cell to read "cancelled" after refetch.
})
```

Then: **pagination** (two task pages; assert "Load next page" appends — row count 2 → 4 and no duplicate `task_id` in the DOM), **artifact ranges** (deliverables page → artifact row → metadata render → range bytes render; second test asserts an out-of-range request surfaces the alert text), **approvals** (two approval pages; assert "Load more" appends items), **mobile progressive disclosure** (viewport 390×844; assert the nav keeps the `plugins` button at `min-height: 44px`, and tabs wrap/remain tappable). Use `page.getByRole("button", { name: ... })` and `aria-label`s already in the component; add `aria-label`s if a control lacks one (component-only change, allowed).

- [ ] **Step 2: Run, watch fail** — `cd packages/app && bunx playwright test e2e/regression/command-center-authority.spec.ts` (app dev server autostarts via `playwright.config.ts`; the app targets `127.0.0.1:4096`, which the mock intercepts). Expected: FAIL — `/experimental/authority/*` routes fall through to a dead backend.

- [ ] **Step 3: Extend `mock-server.ts`** — inside `mockOpenCodeServer`'s route handler, before the `emptyList`/static fallbacks, add:

```ts
const authority = config.authority
if (authority) {
  const match = (re: RegExp) => path.match(re)
  const cancelPath = match(/^\/experimental\/authority\/tasks\/([^/]+)\/cancel$/)
  const deliverablePath = match(/^\/experimental\/authority\/tasks\/([^/]+)\/deliverables$/)
  const artifactRangePath = match(/^\/experimental\/authority\/artifacts\/([^/]+)\/range$/)
  const artifactPath = match(/^\/experimental\/authority\/artifacts\/([^/]+)$/)
  if (path === "/experimental/authority/tasks" && route.request().method() === "GET")
    return json(route, authority.taskPages({ rootId: url.searchParams.get("rootId") ?? "", cursor: url.searchParams.get("cursor") ?? undefined }))
  if (path === "/experimental/authority/roots")
    return json(route, authority.roots?.() ?? { roots: [], next_cursor: null })
  if (path === "/experimental/authority/approvals")
    return json(route, authority.approvals?.({ cursor: url.searchParams.get("cursor") ?? undefined }) ?? { items: [], next_cursor: null })
  if (path === "/experimental/authority/plugin-bundles")
    return json(route, [])
  if (deliverablePath)
    return json(route, authority.deliverables?.({ rootId: deliverablePath[1]!, cursor: url.searchParams.get("cursor") ?? undefined }) ?? { items: [], next_cursor: null })
  if (artifactPath && route.request().method() === "GET")
    return json(route, authority.artifact?.(artifactPath[1]!) ?? null)
  if (artifactRangePath)
    return json(route, authority.artifactRange?.({ artifactId: artifactRangePath[1]!, start: url.searchParams.has("start") ? Number(url.searchParams.get("start")) : undefined, end: url.searchParams.has("end") ? Number(url.searchParams.get("end")) : undefined }) ?? { bytes: [] })
  if (cancelPath && route.request().method() === "POST")
    return json(route, authority.cancel?.({ rootId: cancelPath[1]!, taskId: route.request().postDataJSON().taskId }) ?? { state: "cancelled" })
}
```

(Place this block **after** the `url.port` guard and before the generic fallbacks; keep every branch additive.)

- [ ] **Step 4: Run, watch pass** — `cd packages/app && bunx playwright test e2e/regression/command-center-authority.spec.ts`. Expected: 5 pass.

- [ ] **Step 5: Regression check** — `cd packages/app && bunx playwright test e2e/regression/command-center.spec.ts` still passes; `cd packages/app && bun run typecheck:e2e`.

- [ ] **Step 6: Commit**

```bash
git add packages/app/e2e/utils/mock-server.ts packages/app/e2e/regression/command-center-authority.spec.ts packages/app/src/components/command-center/command-center.tsx
git commit -m "test(app): add authority e2e coverage for cancellation, paging, artifacts, approvals"
```

---

### Task 7: Arabic i18n parity failure — root cause, backfill, CI un-skip

**Files:**
- Modify: `packages/app/src/i18n/parity.test.ts` (remove the CI skip only)
- Modify: `packages/app/src/i18n/{ar,br,bs,da,de,es,fr,ja,ko,no,pl,ru,uk,th,tr,zh,zht}.ts` (backfilled by `translate:app`; never edit `en.ts`)

**Root cause (verified 2026-08-06):** `packages/app/src/i18n/en.ts` gained five keys that no locale defines; the parity suite (`parity.test.ts:45`, `describe.skipIf(!!process.env.CI)`) is skipped in CI, so the drift went unnoticed and now fails the suite's signal value. The missing keys (app domain):

- `dialog.model.unpaid.viewMoreProviders`
- `dialog.provider.custom.label`
- `session.header.reveal.containingFolder`
- `session.header.reveal.fileExplorer`
- `session.header.reveal.finder`

Every non-English locale is missing them; `git log -S session.header.reveal.finder` will show the commit that added them without a backfill. The `ui` and `desktop` domains are currently clean. "Arabic RTL" is the user-visible failure reported in the audit; the parity suite covers all 17 locales including `ar`. There is no RTL layout code path in the app (`rg -i "rtl" packages/app/src` returns only `startLine` matches) — the fix is dictionary parity, not layout.

- [ ] **Step 1: Reproduce (command-verifiable baseline)** — `cd packages/app && bun test src/i18n/parity.test.ts`. Expected: FAIL with `missing` arrays naming the five keys above for each locale.

- [ ] **Step 2: Backfill via the sanctioned tool** — `cd /home/thymia/UltraCode-Planning/opencode && bun run translate:app -- all`. The tool only touches the locale targets it is handed and verifies `missing`/`extra`/placeholder drift (`script/translate-app.test.ts` covers it). If the tool's translation agent is unavailable in this environment, hand-fill the five keys in each of the 17 locale files with concise UI translations that preserve `{{tokens}}` and are not identical to the English value — the parity test is the gate, not the prose. Either way, re-run:

`cd packages/app && bun test src/i18n/parity.test.ts` — Expected: PASS (all four parity tests, all locales).

- [ ] **Step 3: Un-skip in CI** — in `parity.test.ts` change line 45:

```ts
describe.skipIf(!!process.env.CI)("i18n parity", () => {
```
to
```ts
describe("i18n parity", () => {
```

CI runs the unit suite with `CI=true` (the e2e job sets it explicitly; GitHub runners set it for the unit job even with `GITHUB_ACTIONS=false`), so the suite now actually runs in CI. Verify the CI-equivalent locally:

`cd packages/app && CI=true bun test src/i18n/parity.test.ts` — Expected: PASS.

- [ ] **Step 4: Typecheck + full app unit sanity** — `cd packages/app && bun typecheck && bun test src/i18n/parity.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/i18n/parity.test.ts packages/app/src/i18n/ar.ts packages/app/src/i18n/br.ts packages/app/src/i18n/bs.ts packages/app/src/i18n/da.ts packages/app/src/i18n/de.ts packages/app/src/i18n/es.ts packages/app/src/i18n/fr.ts packages/app/src/i18n/ja.ts packages/app/src/i18n/ko.ts packages/app/src/i18n/no.ts packages/app/src/i18n/pl.ts packages/app/src/i18n/ru.ts packages/app/src/i18n/uk.ts packages/app/src/i18n/th.ts packages/app/src/i18n/tr.ts packages/app/src/i18n/zh.ts packages/app/src/i18n/zht.ts
git commit -m "fix(app): backfill i18n parity keys and un-skip parity in CI"
```

---

### Task 8: Bun arm64 extraction blocker — root cause, verified workaround, docs

**Files:**
- Modify: `install` (repo-root installer shell script)
- Modify: `packages/opencode/script/postinstall.mjs`
- Create: `packages/opencode/test/installation/arch-support.test.ts`
- Create: `docs/2026-08-06-bun-arm64-install.md`

**Root cause (verified 2026-08-06, three independent arm64 gaps):**
1. **`install` rejects arm64 Windows.** The supported-combo allowlist (`install:103-110`) is `linux-x64|linux-arm64|darwin-x64|darwin-arm64|windows-x64` — `windows-arm64` is missing even though `.github/workflows/publish.yml` builds and publishes `opencode-windows-arm64` (matrix `aarch64-pc-windows-msvc`). On an ARM64 Windows machine the installer exits `Unsupported OS/Arch`, so the published arm64 artifact is unreachable through the canonical install path.
2. **`postinstall.mjs` hardcodes the `.exe` target name.** `targetBinary` is always `bin/opencode.exe` (`postinstall.mjs:29`). It works on POSIX only by accident (Linux ignores the extension); it is wrong and unverified on every non-Windows arm64 host. `packageNames()` already handles arm64 musl fallback on Linux and `-baseline` is x64-only by design — those branches are correct and must stay untouched.
3. **CI bun setup special-cases only X64.** `.github/actions/setup-bun/action.yml` downloads `bun-${OS}-x64-baseline.zip` for X64 runners; ARM64 runners fall back to `oven-sh/setup-bun`'s default. This is the "Bun" half of the blocker: the build matrix verifies arm64 production builds, but the toolchain fetch has no arm64-specific pin.

Fix: extend the `install` allowlist to include `windows-arm64`, fix `postinstall.mjs` to name the binary per-platform (keep the arm64 `packageNames()` branches as-is), and pin the CI bun URL per arch (arm64 runners resolve the standard arm64 release). Document the root cause and the workaround (a user on arm64 Windows may pass `--binary` to the installer until the fix ships).

- [ ] **Step 1: Write the failing arch-support test** — create `packages/opencode/test/installation/arch-support.test.ts` (plain `bun:test`, no spawn; reads repo files):

```ts
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../../..")
const installer = readFileSync(path.join(root, "install"), "utf8")
const buildScript = readFileSync(path.join(root, "packages/opencode/script/build.ts"), "utf8")

const publishedCombos = [...buildScript.matchAll(/os: "([^"]+)",\s*\n\s*arch: "([^"]+)"/g)].map(
  (m) => `${m[1]}-${m[2]}`,
)

test("installer allowlist accepts every arch combo publish.yml and build.ts produce", () => {
  const allowlist = installer.match(/\b(?:linux|darwin|windows)-(?:x64|arm64)\b/g) ?? []
  for (const combo of new Set(publishedCombos)) {
    expect(allowlist, `installer must accept ${combo}`).toContain(combo)
  }
})

test("postinstall resolves the binary name per platform instead of a hardcoded .exe", () => {
  const postinstall = readFileSync(path.join(root, "packages/opencode/script/postinstall.mjs"), "utf8")
  expect(postinstall).toMatch(/platform === "windows"/)
  expect(postinstall).not.toMatch(/join\(\s*__dirname,\s*"bin",\s*"opencode\.exe"\s*\)/)
})
```

- [ ] **Step 2: Run, watch fail** — `cd packages/opencode && bun test test/installation/arch-support.test.ts`. Expected: FAIL — `windows-arm64` not in the allowlist.

- [ ] **Step 3: Fix `install`** — change the allowlist case to:

```sh
      linux-x64|linux-arm64|darwin-x64|darwin-arm64|windows-x64|windows-arm64)
```

- [ ] **Step 4: Fix `postinstall.mjs`** — make the target binary platform-aware (do NOT touch the `packageNames()`/`isMusl`/`supportsAvx2` branches — they are correct):

```js
const targetBinary = path.join(
  __dirname,
  "bin",
  platform === "windows" ? "opencode.exe" : "opencode",
)
```

- [ ] **Step 5: Run/pass test + installer smoke** — `cd packages/opencode && bun test test/installation/arch-support.test.ts` passes. Then verify the full installation suite: `cd packages/opencode && bun test test/installation/installation.test.ts`.

- [ ] **Step 6: Document the root cause** — create `docs/2026-08-06-bun-arm64-install.md` recording the three findings above, the fix, and the `--binary` workaround for users on unsupported-until-now arm64 Windows. Note in the doc that the app "production-build verification" gate (TODO Stage 7 Follow-Up) is now unblocked because the arm64 install path and the arm64 CI toolchain pin are both covered by tests.

- [ ] **Step 7: Typecheck** — `cd packages/opencode && bun typecheck`.

- [ ] **Step 8: Commit**

```bash
git add install packages/opencode/script/postinstall.mjs packages/opencode/test/installation/arch-support.test.ts docs/2026-08-06-bun-arm64-install.md
git commit -m "fix(install): accept arm64 windows and repair postinstall binary extraction"
```

---

## Run-Level Review Prompt (dispatch after Task 8)

```
Review the commits <list hashes> in /home/thymia/UltraCode-Planning/opencode
implementing RUN-12 (file: opencode/TODO/RUN-12-stage7-ui.md).
Run-specific checks:
1. Inspector placeholders are gone: no authority handler filters read.replay by
   event.kind to fake a projection (grep the diff for `kind.includes`).
2. cancelTask routes through TaskSchedulerAdapter.cancel (live-child dispatch);
   the handler never calls read.cancel directly.
3. Task list accumulation: appendTaskPage dedupes and never replaces; the
   virtualizer count derives from the accumulated list; no new createEffect in
   the command center.
4. One-owner rule: no second sidecar journal writer; the list_roots addition is
   additive only (no semantic change to existing RPCs or transition tables).
5. i18n: en.ts untouched; parity.test.ts no longer skips in CI (grep skipIf).
6. arm64: install accepts every publish.yml combo; postinstall binary name is
   platform-aware; docs/2026-08-06-bun-arm64-install.md exists.
7. E2E: command-center-authority.spec.ts covers the five scenarios and the
   pre-existing command-center.spec.ts still passes.
8. Diff scope: only files declared in the run plan; no session/timeline files.
Then the generic checks from TODO/README.md §5.1 items 1–5.
Reply numbered findings, BLOCKER or MINOR, file:line. No edits.
```

## Deviation Log (fill during execution)

| Task | Deviation | Reason |
|---|---|---|
| 2 | RUN-05 diagnostics read API signature | Verify against `TODO/RUN-05-*.md` at execution time; code wins, update the excerpt, record here. |
| 4 | `list_roots` keyset cursor vs offset paging | Mirror `query_task_graph`'s keyset cursor unless the projections layer makes row-value keysets awkward; the RPC contract + tests are the invariant. |
