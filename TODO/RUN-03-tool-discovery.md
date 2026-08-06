# RUN-03: V2 Tool Discovery + Plugin/MCP Canonical Tool Registration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the already-built BM25 deferred tool discovery (`packages/core/src/tool/discovery.ts`) into the V2 runner so large tool surfaces stop paying schema tokens every turn, and close the two registration gaps that make discovery matter: canonical registration for MCP tools and for plugin-contributed tools.

**Architecture:** MCP and plugin tools become scope-owned registrations in the Location-scoped `Tools.Service` (replayable, disposable, latest-wins — the existing registry semantics). Per provider turn, the runner passes a deterministic query into `Tools.materialize(permissions, query)`; tools outside the always-set are advertised through the injected `search_tools` BM25 meta-tool instead of full schemas. Tool-set changes bust the provider cache, so materialization is sticky per session until the query changes (recorded as a context-source-like signal, not re-derived mid-turn).

**Tech Stack:** Bun, TypeScript, Effect-TS; no new dependencies.

**Audit basis:** §5.5 (discovery orphaned), §12 (deferred discovery best-practice), `packages/core/src/tool/AGENTS.md` "Current Gaps", §13 (tool-search row), §20 item missing MCP-lazy loading (Amp MCP-in-skill pattern).

## Global Constraints

`TODO/README.md` §2 verbatim, plus:

- The model-visible tool set for a given (session, query fingerprint) is byte-stable across restarts: materialization results are sorted deterministically (namespace, then name) and persisted with the session agent state or recomputed from the same inputs — never from wall-clock or map iteration order.
- `search_tools` is synthesized by the registry; tools it returns become visible for the NEXT provider turn (tool-set transition only at safe provider-turn boundaries, mirroring system-context rules).
- MCP tool registration must produce identical tool identities as the V1 path (`McpCatalog.sanitize` prefixes) — no identity drift between V1 and V2 for the same server.
- Branch: `tool-discovery`.

## Orchestrator Brief

### Context Files (read in full before Task 1)

1. `packages/core/src/tool/AGENTS.md` — gaps statement; quote it in every subagent prompt.
2. `packages/core/src/tool/{tool.ts,registry.ts,discovery.ts,application-tools.ts,builtins.ts}` — registration semantics (`register`, `materialize(permissions, query?)`, `search_tools` injection condition), definition opacity (WeakMap), permission filtering (`whollyDisabled`).
3. `packages/core/src/session/runner/llm.ts` — the exact `materialize(...)` call site and `LLM.request` assembly.
4. `packages/opencode/src/mcp/index.ts` and any `mcp/catalog.ts` — how V1 builds MCP tools (`MCP.tools()`), name sanitization (`client_tool`), permission action mapping, `ToolsChanged` event.
5. `packages/core/src/plugin/{host.ts,hooks.ts,bundle.ts}` and `packages/plugin/src/v2/effect/PLAN.md` (Transform semantics section — replayable domain builds, serialized rebuilds, scope-owned registrations).
6. `packages/ultracode-skills/src/discovery.ts` — skills that carry MCP servers (future lazy-MCP seam; read only).
7. Tests: `ls packages/core/test/tool/` — reuse the registry test harness.

### Baselines

```bash
cd packages/core && bun test test/tool 2>&1 | tail -5
cd packages/core && bun typecheck 2>&1 | tail -3
rg -n "materialize" packages/core/src/session/runner/llm.ts
rg -n "search_tools" packages/core/src/tool/registry.ts
```

### Dispatch Order

1 → 5 sequential. All tasks confine themselves to `packages/core` except Task 2's MCP bridge, which lives in `packages/opencode` (integration seam) with tests there.

### Definition of Done

- [ ] With 30+ tools registered across MCP + plugins + builtins, a V2 turn with a focused query materializes ≤ (core set + top-5) full schemas and exactly one `search_tools` tool (integration test snapshot of `LLM.request.tools`).
- [ ] `search_tools` results become materialized schemas on the NEXT provider turn only (test proves no mid-turn mutation).
- [ ] MCP tools registered in V2 have byte-identical names/permission mapping to V1 for a fixture server (parity test).
- [ ] Disposing an MCP server connection (or plugin scope) removes its tools from the next turn's materialization (registration finalizers work).
- [ ] A defensively brutal cache-stability test: two consecutive turns with unchanged query produce byte-identical `tools` arrays (deep equal).
- [ ] `bun typecheck` green in `packages/core` and `packages/opencode`.

---

### Task 1: Characterize discovery + registry (pin behavior)

**Files:**
- Test: `packages/core/test/tool/discovery-characterization.test.ts`

**Interfaces:** Consumes existing `ToolDiscovery.search`, `ToolRegistry.materialize`. Produces: pinned behavior notes (scoring order, limit, empty-query behavior, `search_tools` injection condition) in test assertions; no source changes.

- [ ] **Step 1:** Write tests pinning: (a) query `nil`/absent → all permitted tools, no `search_tools`; (b) query with match → top-5 + `search_tools` appended; (c) no matches → `search_tools` only; (d) results sorted deterministically; (e) wholly-denied tools never appear regardless of query. Use the existing registry test helpers to build fake definitions.
- [ ] **Step 2:** Run — `cd packages/core && bun test test/tool/discovery-characterization.test.ts`. Any violated expectation → `.fails` marker + deviation log entry, do not fix here.
- [ ] **Step 3:** Commit — `test(core): pin tool discovery/registry behavior before wiring`

### Task 2: MCP tools → canonical V2 registration

**Files:**
- Create: `packages/opencode/src/mcp/v2-registration.ts`
- Modify: `packages/opencode/src/mcp/index.ts` (emit registration lifecycle events alongside V1 wiring)
- Test: `packages/opencode/test/mcp/v2-registration.test.ts`

**Interfaces:**
- Consumes: `Tools.Service.register({[name]: tool})` + finalizer semantics (Context File 2); V1 `MCP.tools()` output shape.
- Produces: `registerMcpServerTools(serverName, tools[]): Effect<Scope-owned registration>`; tool definitions carry `namespace: "mcp:<server>"`, `concurrencySafe`/`stateChanging` defaults false unless declared, permission action mapping `mcp` with resource `server:tool` (match V1 exactly — read V1's mapping code and port it, crediting provenance if you found an analogous mapping in `../codex`; likely none, so no ledger entry needed).

- [ ] **Step 1: Failing test** — fixture server with 3 tools (text result, image result, error); after registration the V2 registry materializes them under identical names as `McpCatalog.sanitize` produces; dispose scope → gone. Parity assertion: `expect(v2Names).toEqual(v1Names)`.
- [ ] **Step 2–5:** run/fail → implement (translate the V1 tool wrapper's execute into a V2 `Tool.make` `execute`, reusing the same result-normalization code path as V1 — extract a shared helper if both call sites need it; do not duplicate logic) → run/pass → typecheck.
- [ ] **Step 6: Commit** — `feat(opencode): register MCP tools into the canonical tool registry`

### Task 3: Plugin tool transform domain (V2)

**Files:**
- Modify: `packages/core/src/plugin/host.ts` (add `tools` domain to `PluginHost`)
- Modify: `packages/core/src/plugin/hooks.ts` (or `bundle.ts`, per Context File 5's pattern)
- Test: `packages/core/test/plugin/tools-domain.test.ts`

**Interfaces:**
- Consumes: transform-domain machinery (register/dispose/rebuild per PLAN.md semantics).
- Produces: `PluginHost.tools.register(defs: Tool.Definition[]): Effect<Registration>`; plugin tools get `namespace: "plugin:<plugin-id>"`; rebuilds are serialized and coalesced like other domains; scope close removes plugin tools.

- [ ] **Step 1: Failing test** — a fixture plugin registers one tool at boot and one later (`reload()`); assert materialization reflects batch-then-rebuild order; dispose → replaced-by-previous registration (latest-wins reveal).
- [ ] **Step 2–5:** run/fail → implement minimal domain following the `skill`/`command` domain template verbatim → run/pass → typecheck (`packages/core`).
- [ ] **Step 6: Commit** — `feat(core): plugin tools transform domain`

### Task 4: Runner query wiring (sticky, boundary-safe)

**Files:**
- Modify: `packages/core/src/session/runner/llm.ts`
- Create: `packages/core/src/tool/query.ts` (pure query builder)
- Test: `packages/core/test/tool/query.test.ts`, `packages/core/test/session/materialization.test.ts`

**Interfaces:**
- Consumes: `materialize(permissions, query)` (Task 1 pinned), agent info (system/description), last promoted user message text.
- Produces: `buildToolQuery({ agentDescription, agentName, lastUserText }): string | undefined` (pure, ≤12 tokens, keyword-extracted, deterministic); runner stores the active query fingerprint on the drain state; a NEW query fingerprint takes effect at the next safe provider-turn boundary (never mid-turn); the materialized definitions array for identical fingerprint is reused verbatim (memoized per drain).

- [ ] **Step 1: Failing tests** — `query.test.ts` (determinism, length cap, undefined when no signal); `materialization.test.ts` (same fingerprint → byte-identical `LLM.request.tools` deep equal across two turns; changed fingerprint → transition at boundary, not mid-turn — simulate a tool call completing mid-turn and assert no re-materialization until the next turn).
- [ ] **Step 2–5:** run/fail → implement → run/pass → typecheck.
- [ ] **Step 6: Commit** — `feat(core): wire deferred tool discovery into the V2 runner`

### Task 5: Visibility + docs + ledger

**Files:**
- Modify: `packages/core/src/tool/AGENTS.md` — remove the two gaps you closed (MCP/Session registration; plugin boot), replace with the new invariants (sticky query, boundary-only transitions).
- Modify: `TODO/README.md` §7 tick RUN-03 rows; §8 ledger.

- [ ] **Step 1:** Update docs; verify no other gap statement in the AGENTS.md is now stale.
- [ ] **Step 2:** Commit — `docs(core): tool registry gaps closed by RUN-03`

---

## Run-Level Review Prompt (dispatch after Task 5)

```
Review commits <hashes> implementing RUN-03 (opencode/TODO/RUN-03-tool-discovery.md).
Run-specific checks:
1. Cache stability: for a fixed query fingerprint the tools array is
   byte-identical across turns and restarts (find the memoization /
   deterministic sort; confirm no Date.now/Math.random/Object key iteration
   order affects it).
2. Boundary discipline: materialization transitions never occur mid-turn;
   search_tools results land next turn only.
3. V1/V2 identity parity for MCP tools (names + permission mapping).
4. Scopes: every registration path (MCP, plugin) is scope-owned and disposes
   cleanly; no process-global leaks.
5. One-owner rule: all tool materialization flows through Tools.Service /
   ToolRegistry — no second registry introduced.
Then TODO/README.md §5.1 generic checks. Numbered findings, BLOCKER/MINOR,
file:line. No edits.
```

## Deviation Log

| Task | Deviation | Reason |
|---|---|---|
