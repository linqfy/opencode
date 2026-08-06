# RUN-11: codemode v2 — Confined REPL Operator Mode with DAG Spawn

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the experimental `execute` tool into a first-class, config-gated confined REPL: a persistent per-session namespace plus a permission-gated host RPC surface (fs, shell, memory, `search_tools`, `spawn`/`wait`/`sendMailbox` over the RUN-01 DAG) built on the existing `@opencode-ai/codemode` confined interpreter.

**Architecture:** The host RPC layer and namespace live in `packages/opencode/src/repl/` (new) because `packages/codemode/AGENTS.md` mandates the package stays host-neutral — "Applications own authorization, persistence, external authority". `packages/codemode` gains only a small additive `state` capability (a persistent per-execution binding) because the interpreter is stateless today. Every REPL RPC method is an audited side effect flowing through the SAME V1 `Permission` pipeline native tools use (`ctx.ask`), mirroring how the current `execute` tool gates MCP child calls (`packages/opencode/src/tool/code-mode.ts:147`). The REPL may not escape its isolate: confinement is structural (no `eval`, no imports, no host globals, no network) and the host RPC tree is the only external surface.

**Tech Stack:** Bun, TypeScript, Effect-TS, `@opencode-ai/codemode` (acorn AST interpreter — NOT QuickJS/Rune), `@opencode-ai/core` V2 `Tools.Service` registry (RUN-03), `@ultracode/agents` scheduler + `@ultracode/events-client` artifact store (RUN-01), `@ultracode/memory` `redactSecrets` (RUN-02). No new dependencies.

**Audit basis:** §14.5 ("Port (modified) as `codemode` v2 … keep your tool suite, make REPL *additive*"; "`rlm(...)` → admission-handle subagents: port onto your DAG … add a programmatic `spawn()` inside codemode that returns the durable task ID"), §17.1, §18-A3 (the entire run), §20.11 n/a.

## Global Constraints

All constraints in `TODO/README.md` §2 apply verbatim. In addition:

- **One-owner rule:** `@opencode-ai/codemode` is THE one confined code-exec primitive. Verified today: its only consumer is `packages/opencode/src/tool/code-mode.ts` (grep `@opencode-ai/codemode` across `packages/*/src`). No task may introduce a second REPL/code-exec primitive; if one appears, STOP and escalate (README §2.4).
- **Confinement is the interpreter, not a process sandbox.** The package does NOT ship a filesystem/process sandbox (README "Not a sandbox" note). Escape-safety comes from (a) the interpreter's rejected syntax (`eval`, imports, `globalThis`, host globals, `fetch`, timers, prototype mutation) and (b) the host RPC tree being the only external surface. Safety tests (Task 7) assert both.
- **Every host RPC method declares a permission action** and routes through the V1 `Permission` pipeline (`ctx.ask`), same as native tools. No method may perform a side effect without an `ask` (read-only methods declare `readonly: true` and call no `ask`).
- **REPL state is per-session, snapshot-able to the artifact store, and snapshots exclude secrets** via `redactSecrets` from `@ultracode/memory` (RUN-02 reuse). Redaction cannot be disabled.
- **Output bounded through `ToolOutputStore` semantics**: mirror `MAX_LINES = 2000` / `MAX_BYTES = 50*1024` (`packages/core/src/tool-output-store.ts:13-14`) as the REPL's `ExecutionLimits.maxOutputBytes` default; oversized results are truncated with a marker, never dropped silently, never blocking past the timeout.
- **`spawn` returns an admission handle, never the answer** (Prime's `rlm(...)` semantics). `wait` never blocks past its `timeoutMs`; on timeout it returns a typed `wait_timeout` result carrying `pending` ids.
- **Branch:** `codemode-v2`.
- **Provenance:** this run reimplements an observed product behavior (Prime Agent RLM described in audit §14) — no code is copied from `../prime-agent`; no ledger entry is required. If any subagent reads `../prime-agent` sources, it MUST stop and add a ledger entry per `docs/provenance/ledger.json` before writing code.
- **V1 freeze (README §2.10):** `session/prompt.ts`, `processor.ts`, `session.ts` untouched. The `execute` tool is an existing V1 tool (like `shell`/`read`); it is evolved, not a session-core change. The only non-tool opencode files touched are `tool/registry.ts` (tool gating) and `agent/scheduler-service.ts` (additive interface passthrough, Task 4).
- **Deviations from the audit text:** §18-A3 says "Bun-worker or QuickJS isolate". Code reality (verified): `packages/codemode` is an in-process acorn AST interpreter (no eval), confined syntactically — NOT a QuickJS/Bun-worker. The plan reuses this isolate as-is (per the run brief "Reuse its isolate, do not rebuild it"); no worker thread is introduced. Recorded in the Deviation Log.

## Orchestrator Brief

### Context Files (read in full before dispatching Task 1)

1. `packages/codemode/src/{codemode,tool,tool-runtime,values,tool-error}.ts` — the runtime API: `CodeMode.make`/`execute`, `ExecutionLimits { timeoutMs, maxToolCalls, maxOutputBytes }`, `Result` (`Success | Failure`), `Tool.make`, `copyIn`/`copyOut` plain-data boundary, `$codemode.search` reserved namespace. Note: **each `execute` builds a fresh `Interpreter` with a fresh global scope — state does NOT persist across executions** (`runtime.ts:617-661` seeds globals; `executeWithLimits` at `:3340` constructs per call).
2. `packages/codemode/src/interpreter/{runtime,model}.ts` — the interpreter: constructor seeds `globalScope`; `run` pushes a module scope and pops it in an `Effect.ensuring` finalizer (`:668-698`). This is where the `state` binding lands in Task 5.
3. `packages/codemode/README.md` and `packages/codemode/AGENTS.md` — confinement list (no `eval`, no modules/classes/generators/timers/fetch/host globals; "CodeMode is an orchestration language, not a general JavaScript runtime"), "host capabilities explicit" rule.
4. `packages/opencode/src/tool/code-mode.ts` (full) — the experimental `execute` tool: `Parameters = { code }`, `CODE_MODE_TOOL = "execute"`, permission per MCP child call via `ctx.ask({ permission: entry.key, ... })`, plugin `tool.execute.before/after`, `projectMcpResult`, cancellation via `Effect.raceFirst`.
5. `packages/opencode/src/tool/registry.ts` (lines ~86-250) — the V1 registration gate: `flags.experimentalCodeMode ? dynamic-import code-mode : undefined` (`:113-114`), `Tool.init(codeModeTool)` exposed as `execute` (`:221,241`). Also `packages/opencode/src/session/tools.ts:397` (`if (flags.experimentalCodeMode) return tools` — the V1-loop MCP short-circuit; leave unchanged, note in deviations).
6. `packages/opencode/src/effect/runtime-flags.ts` — `experimentalCodeMode: enabledByExperimental("OPENCODE_EXPERIMENTAL_CODE_MODE")` (`:48`). Superseded by config in Task 6.
7. `packages/opencode/src/tool/{write,read,shell,task}.ts` + `external-directory.ts` — the permission surfaces the RPC methods mirror: `write.ts` asks `permission: "edit"`; `assertExternalDirectoryEffect(ctx, target)` enforces Location-root scope with action `external_directory`; `task.ts` asks `permission: "task"` with `patterns: [subagent_type]`.
8. `packages/core/src/file-mutation.ts` — `FileMutation.Service` (`@opencode/v2/FileMutation`): `create/write/writeTextPreservingBom/writeIfUnchanged/remove` over `Target { canonical, resource }`. This is the fs-write path the REPL `fs.write` method uses.
9. `packages/core/src/tool/registry.ts` + `packages/core/src/tool/{tool,discovery}.ts` — RUN-03 produced interfaces: `Tools.Service.register({ [name]: Tool.make })` (scope-owned), `materialize(permissions?, query?)`, `Tool.make`/`withPermission`, `ToolDiscovery.search(query, tools)`.
10. `packages/ultracode-agents/src/scheduler.ts` + `packages/opencode/src/agent/scheduler-service.ts` + `packages/opencode/src/tool/task.ts` (`TaskSchedulerAdapter`) — the DAG surface: `createScheduler(client).spawn/admit/sendMailbox/commitDeliverable`, `SchedulerClient` pick, `TaskSchedulerAdapter.schedule/cancel`, `Handle { rootId, taskId, status, summary, evidence }`.
11. `packages/ultracode-events-client/src/index.ts` — `putArtifact(bytes, mime, ownerScope, retention, credentialClass) -> ArtifactRef`, `openRange`, `statArtifact` (`:277-303`). The artifact-store snapshot substrate.
12. `packages/core/src/tool-output-store.ts` — the 2000-line/50KiB bounding constants the REPL output cap mirrors.
13. `packages/ultracode-memory/src/extract.ts` — `redactSecrets(text)` + `SECRET_PATTERNS`; reused verbatim for snapshot redaction (Task 5).
14. RUN-01 produced interfaces (consume, do not re-derive): `Scheduler.waitForTasks({ taskIds, timeoutMs, pollMs? }) -> Promise<TaskTerminalOutcome[]>`; `WaitTimeoutError` (`_tag: "WaitTimeoutError"`, `pending: string[]`); `UnknownTaskError` — all per `TODO/README.md` §7 and RUN-01 Task 5. **If RUN-01 is not marked DONE in the ledger, do not start Task 4.**
15. `packages/core/src/config/compaction.ts` + `packages/core/src/config/experimental.ts` — the V2 config self-export pattern (`export * as ConfigCompaction from "./compaction"`) the new `codemode` group follows.
16. Test conventions: `packages/codemode/test/codemode.test.ts`, `packages/opencode/test/tool/code-mode.test.ts` (harness with `Layer.mock` for Plugin/Truncate/Agent/Session/MCP + `ctx.ask` recorder), `packages/opencode/test/AGENTS.md` (testEffect / `it.instance`).

### Baselines (record before Task 1)

```bash
cd packages/codemode && bun test 2>&1 | tail -5
cd packages/codemode && bun typecheck 2>&1 | tail -3
cd packages/opencode && bun test test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts 2>&1 | tail -5
cd packages/opencode && bun typecheck 2>&1 | tail -3
cd packages/core && bun test test/tool 2>&1 | tail -5
cd packages/opencode && rg -n "waitForTasks|TaskTerminalOutcome" packages/ultracode-agents/src/scheduler.ts
```

### Dispatch Order

Tasks 1 → 8 strictly sequential. Task 4 consumes RUN-01 interfaces; Task 6 touches the V1 registry gating and must not run before Tasks 3–5 land (its assembly needs `methods.ts`, the namespace service, and `makeWithState`).

### Definition of Done (verify each with a command you ran)

- [ ] A confined program that assigns `state` in one `execute` sees it in the next (same `StatefulRuntime`), and a fresh runtime seeded with a restored snapshot sees it too (`packages/codemode/test/state.test.ts` round-trip).
- [ ] The REPL tool's host RPC tree exposes exactly the methods `fs.read`, `fs.write`, `shell.run`, `memory_query`, `search_tools`, `spawn`, `wait`, `send_mailbox`; each declares a permission action; unknown methods return a typed `unknown_method` error.
- [ ] `fs.write` through the REPL performs a real audited write via `FileMutation.Service` after `ask({ permission: "edit", ... })`; a denied `ask` leaves the filesystem untouched and returns `permission_denied` to the program (assert file absent).
- [ ] `spawn` returns an admission handle `{ rootId, taskId, status, summary }` (never the answer); `wait({ taskIds, timeoutMs })` resolves with terminal outcomes or returns a typed `wait_timeout` result within `timeoutMs` (never hangs the turn).
- [ ] A program that attempts `eval(...)`, `globalThis`, `process`, `require`, `import(...)`, `fetch`, or prototype mutation fails with a diagnostic and performs no side effect.
- [ ] A REPL result exceeding 50KiB (default `maxOutputBytes`) is truncated with a marker; oversized console logs are kept to the remaining budget (`truncated: true`).
- [ ] A namespace snapshot written via `putArtifact` contains no matched secret (`redactSecrets` applied; assert no `sk-`/`AKIA`/`api_key=` in the stored bytes).
- [ ] `codemode.enabled` default `false`: with it unset, the `execute` tool is not registered and the REPL engine is never constructed; with it `true`, the tool is registered and materializes from the V2 registry (`Tools.Service.register`).
- [ ] `bun typecheck` green in `packages/codemode`, `packages/opencode`, `packages/core`.
- [ ] `git status` clean; branch `codemode-v2`; run ledger §8 row appended.

---

### Task 1: Characterize the codemode isolate + execute tool gating + permission surface (pin with tests)

**Files:**
- Create: `packages/codemode/test/characterization.test.ts`
- Create: `packages/opencode/test/repl/characterization.test.ts`
- Test only; no source changes.

**Interfaces:**
- Consumes: `CodeMode.make`/`execute`, `ExecutionLimits`, `Tool.make` (Context File 1); `CodeModeTool`, `describeCatalog`, `CODE_MODE_TOOL` (Context File 4).
- Produces: a pinned behavior contract the later tasks rely on, expressed as assertions:
  1. codemode executions are **stateless** (two `execute` calls share nothing);
  2. `maxToolCalls` and `maxOutputBytes` are enforced and return `toolCalls`/`truncated` metadata;
  3. the `$codemode` tool namespace is reserved (`assertValidTools` throws);
  4. the `execute` tool is gated by `RuntimeFlags.experimentalCodeMode` (off by default) and asks permission per MCP child call keyed by the flat catalog name (`fixtures_add`);
  5. the host permission actions the RPC methods will reuse are `edit` (write), `read`, `bash`, `task`, `external_directory` — pinned by reading the existing tools' `ask` calls in the assertion comments only, not by re-implementing them.

- [ ] **Step 1: Write the failing tests**

`packages/codemode/test/characterization.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { CodeMode, Tool } from "../src/index"
import { Effect } from "effect"

const runtime = () =>
  CodeMode.make({
    tools: {
      math: {
        add: Tool.make({
          description: "Add two numbers",
          input: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
          run: ({ a, b }) => Effect.succeed(a + b),
        }),
      },
    },
  })

describe("codemode characterization", () => {
  test("executions are stateless: no binding survives an execute call", async () => {
    const r = runtime()
    const first = await Effect.runPromise(r.execute("const x = 41; return x"))
    expect(first.ok).toBe(true)
    const second = await Effect.runPromise(r.execute("return typeof x"))
    expect(second.ok).toBe(true)
    expect(second.ok && second.value).toBe("undefined")
  })

  test("maxToolCalls is enforced with a diagnostic", async () => {
    const r = CodeMode.make({
      tools: {
        math: {
          add: Tool.make({
            description: "Add",
            input: { type: "object", properties: {} },
            run: () => Effect.succeed(1),
          }),
        },
      },
      limits: { maxToolCalls: 1 },
    })
    const result = await Effect.runPromise(
      r.execute("await tools.math.add({}); await tools.math.add({}); return 'unreachable'"),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("ToolCallLimitExceeded")
  })

  test("maxOutputBytes truncates with a marker and sets truncated", async () => {
    const r = CodeMode.make({ limits: { maxOutputBytes: 32 } })
    const result = await Effect.runPromise(r.execute("return 'x'.repeat(4096)"))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.truncated).toBe(true)
      expect(typeof result.value).toBe("string")
      expect(String(result.value).length).toBeLessThan(100)
      expect(String(result.value)).toContain("output limit")
    }
  })

  test("$codemode is a reserved tool namespace", () => {
    expect(() =>
      CodeMode.make({
        tools: {
          $codemode: {
            search: Tool.make({
              description: "nope",
              input: { type: "object", properties: {} },
              run: () => Effect.succeed(null),
            }),
          },
        },
      }),
    ).toThrow(/\$codemode/)
  })
})
```

`packages/opencode/test/repl/characterization.test.ts` (reuse the harness from `test/tool/code-mode.test.ts` verbatim — copy the `Layer.mock` layer and the `mcpTool` helper):

```ts
import { describe, expect, test } from "bun:test"
import { CodeModeTool } from "@/tool/code-mode"
import { Tool } from "@/tool/tool"
import { MessageID, SessionID } from "@/session/schema"
import { Effect } from "effect"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_repl_char"),
  messageID: MessageID.make("msg_repl_char"),
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_repl_char",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("execute tool gating + permission surface", () => {
  test("each MCP child call asks permission keyed by the flat catalog name", async () => {
    const asked: string[] = []
    const permCtx: Tool.Context = { ...ctx, ask: (req: any) => Effect.sync(() => void asked.push(req.permission)) }
    // build the tool with the shared harness from test/tool/code-mode.test.ts (one fixture tool),
    // then:
    await Effect.runPromise(
      tool.execute({ code: "await tools.fixtures.get_text({ name: 'x' }); return 'done'" }, permCtx),
    )
    expect(asked).toEqual(["fixtures_get_text"])
  })

  test("experimentalCodeMode is off by default (registry omits execute)", () => {
    // pin via the registry gate: RuntimeFlags.layer({}) must yield no execute tool id.
    // assert `!(yield* ToolRegistry.Service).ids().includes("execute")` — see registry.test.ts harness.
  })
})
```

(The second test asserts the registry gate with the existing `packages/opencode/test/tool/registry.test.ts` harness — copy its layer-building shape. If the real code already registers `execute` when the flag is off, mark the test `.fails` with a comment and record it in the Deviation Log; do not fix here.)

- [ ] **Step 2: Run, watch fail / or pass**

Run: `cd packages/codemode && bun test test/characterization.test.ts`
Expected: the first three codemode tests PASS (they pin existing behavior). The reserved-namespace test also PASSES. If any FAILS, mark `.fails` with a comment and log the deviation — do not fix.

Run: `cd packages/opencode && bun test test/repl/characterization.test.ts`
Expected: the permission-key test passes (mirrors existing `code-mode.test.ts`); the gating test passes or is marked `.fails` per above.

- [ ] **Step 3: Commit**

```bash
git add packages/codemode/test/characterization.test.ts packages/opencode/test/repl/characterization.test.ts
git commit -m "test(codemode): pin isolate, execute gating, and permission surface"
```

---

### Task 2: Host RPC protocol + dispatch layer

**Files:**
- Create: `packages/opencode/src/repl/host.ts`
- Create: `packages/opencode/test/repl/host.test.ts`

**Interfaces:**
- Consumes: `Tool.Context["ask"]` shape (`Omit<PermissionV1.Request, "id" | "sessionID" | "tool">`, `packages/opencode/src/tool/tool.ts:45`); `PermissionV1` error channel (`@opencode-ai/core/v1/permission`).
- Produces:
  - `export type RpcRequest = { readonly id: string; readonly method: string; readonly params: unknown }`
  - `export const RpcRequestSchema = Schema.Struct({ id: Schema.String, method: Schema.String, params: Schema.Json })`
  - `export const RpcErrorCode = Schema.Literal("unknown_method", "invalid_params", "permission_denied", "method_failed", "wait_timeout")`
  - `export class RpcError extends Schema.TaggedErrorClass<RpcError>()("Repl.RpcError", { code: RpcErrorCode, message: Schema.String })` with a `pending: string[]` optional field (`Schema.optional`).
  - `export type RpcResponse = { readonly id: string; readonly ok: true; readonly result: unknown } | { readonly id: string; readonly ok: false; readonly error: { readonly code: ...; readonly message: string; readonly pending?: string[] } }`
  - `export type HostMethod = { readonly method: string; readonly permissionAction: string; readonly readonly?: true; readonly input: Schema.Decoder<unknown>; readonly output: Schema.Decoder<unknown>; readonly permission: (params: unknown) => Omit<PermissionV1.Request, "id" | "sessionID" | "tool">; readonly run: (ctx: HostRpcContext, params: unknown) => Effect.Effect<unknown, RpcError> }`
  - `export type HostRpcContext = { readonly sessionID: SessionID; readonly messageID: MessageID; readonly agent: string; readonly ask: Tool.Context["ask"]; readonly callID: string }`
  - `export const dispatch = Effect.fn("Repl.dispatch")(function* (registry: Readonly<Record<string, HostMethod>>, request: RpcRequest, ctx: HostRpcContext): Effect.Effect<RpcResponse, never>)` — semantics: unknown method → `unknown_method`; `RpcRequestSchema` decode failure → `invalid_params`; then for a non-`readonly` method, `yield* ctx.ask(method.permission(params))` where denial surfaces as `permission_denied` (catch `PermissionV1.Error`); then `method.run(ctx, params)`; success encoded through `Schema.Json` (`Schema.encodeUnknown`) and returned as `{ ok: true, result }`; `run` failures surface as `method_failed` with the error message.

Dispatch is pure over the registry + ctx, so it is unit-tested with an inline test registry (the real `methods.ts` registry arrives in Tasks 3–4). Every `HostMethod` MUST declare `permissionAction` and, unless `readonly`, a `permission(params)` function — a `HostMethod` missing them is a type error (no `?`).

- [ ] **Step 1: Write the failing test** — `packages/opencode/test/repl/host.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { dispatch, type HostMethod, type HostRpcContext } from "@/repl/host"
import { MessageID, SessionID } from "@/session/schema"

const ctx: HostRpcContext = {
  sessionID: SessionID.make("ses_host"),
  messageID: MessageID.make("msg_host"),
  agent: "build",
  callID: "call_host",
  ask: () => Effect.void,
}

const registry: Readonly<Record<string, HostMethod>> = {
  echo: {
    method: "echo",
    permissionAction: "echo",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.String,
    permission: () => ({ permission: "echo", metadata: {}, patterns: ["*"], always: ["*"] }),
    run: (_ctx, params) => Effect.succeed((params as { text: string }).text),
  },
  denied: {
    method: "denied",
    permissionAction: "secret",
    input: Schema.Unknown,
    output: Schema.String,
    permission: () => ({ permission: "secret", metadata: {}, patterns: ["*"], always: ["*"] }),
    run: () => Effect.succeed("must never run"),
  },
}

describe("repl host dispatch", () => {
  test("unknown method returns a typed unknown_method response", async () => {
    const res = await Effect.runPromise(dispatch(registry, { id: "1", method: "nope", params: {} }, ctx))
    expect(res).toEqual({ id: "1", ok: false, error: { code: "unknown_method", message: expect.any(String) } })
  })

  test("invalid params return invalid_params without calling run", async () => {
    const res = await Effect.runPromise(dispatch(registry, { id: "2", method: "echo", params: { text: 42 } }, ctx))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe("invalid_params")
  })

  test("successful method encodes its result", async () => {
    const res = await Effect.runPromise(dispatch(registry, { id: "3", method: "echo", params: { text: "hi" } }, ctx))
    expect(res).toEqual({ id: "3", ok: true, result: "hi" })
  })

  test("permission denial returns permission_denied and never runs the method", async () => {
    let ran = false
    const denyingCtx: HostRpcContext = { ...ctx, ask: () => Effect.fail(new Error("denied")) }
    const local = {
      denied: { ...registry.denied, run: () => Effect.sync(() => { ran = true; return "bad" }) },
    } as typeof registry
    const res = await Effect.runPromise(dispatch(local, { id: "4", method: "denied", params: {} }, denyingCtx))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe("permission_denied")
    expect(ran).toBe(false)
  })

  test("method failures surface as method_failed", async () => {
    const local = {
      denied: { ...registry.denied, run: () => Effect.fail(new RpcError({ code: "method_failed", message: "boom" })) },
    } as typeof registry
    const res = await Effect.runPromise(dispatch(local, { id: "5", method: "denied", params: {} }, ctx))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.message).toBe("boom")
  })
})
```

- [ ] **Step 2: Run, watch it fail**

Run: `cd packages/opencode && bun test test/repl/host.test.ts`
Expected: FAIL — module `@/repl/host` does not exist.

- [ ] **Step 3: Implement `src/repl/host.ts`** — happy path on top: `dispatch` decodes the request (`RpcRequestSchema` → on failure respond `invalid_params`), looks up the method (missing → `unknown_method`), for non-readonly methods calls `ctx.ask(method.permission(params))` catching `PermissionV1.Error` → `permission_denied`, then `method.run(ctx, params)`; wrap run errors as `method_failed`; encode the result via `Schema.encodeUnknown(Schema.Json)` and return `{ id, ok: true, result }`. All responses constructed as plain objects (no `else`, no `try/catch` beyond the Effect catch operators). Import `PermissionV1` from `@opencode-ai/core/v1/permission` for the error tag.

- [ ] **Step 4: Run, watch it pass** — same command as Step 2. Then `cd packages/opencode && bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/repl/host.ts packages/opencode/test/repl/host.test.ts
git commit -m "feat(opencode): typed REPL host RPC dispatch with permission gating"
```

---

### Task 3: RPC methods — fs, shell, search_tools, memory_query through existing services

**Files:**
- Create: `packages/opencode/src/repl/methods.ts`
- Create: `packages/opencode/test/repl/methods.test.ts`

**Interfaces:**
- Consumes: `HostMethod`/`HostRpcContext`/`RpcError` (Task 2); `FileMutation.Service` (`@opencode-ai/core/file-mutation`); `FSUtil.Service` (`@opencode-ai/core/fs-util`); `assertExternalDirectoryEffect` (`@/tool/external-directory`); `ToolDiscovery.search` (`@opencode-ai/core/tool/discovery`); `findRelevantMemories` (`@ultracode/memory`); `PermissionV1`; `Tool.Context["ask"]`.
- Produces:
  - `export type HostRpcDeps = { readonly fs: { readonly readFile: (path: string) => Promise<Uint8Array | undefined>; readonly mutation: Pick<FileMutation.Interface, "writeTextPreservingBom" | "create" | "write"> }; readonly shell: { readonly run: (input: { command: string; cwd?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }> }; readonly discover: (query: string) => ReadonlyArray<{ name: string; namespace: string; description: string }>; readonly memory: { readonly query: (text: string) => Promise<ReadonlyArray<{ title: string; text: string }>> }; readonly scheduler?: DagDeps }` where `DagDeps` is declared in Task 4 (`spawn`/`waitForTasks`/`sendMailbox`) as optional here so Task 3 compiles standalone.
  - `export const buildHostMethods(deps: HostRpcDeps): Readonly<Record<string, HostMethod>>` returning exactly: `fs.read`, `fs.write`, `shell.run`, `search_tools`, `memory_query`.
    - `fs.read`: `input: { path: string }`, `output: { text: string | null; bytes: number }`, `permissionAction: "read"`, `permission(params)` mirrors `read.ts`'s `ask` (verify the exact shape in Context File 7; it includes `patterns` from the Location-relative path and `metadata: { path }`); `run` enforces Location-root via `assertExternalDirectoryEffect` (adapt the `Tool.Context` into a minimal ask) then reads via `deps.fs.readFile` and decodes UTF-8 (BOM-strip via the same logic `write.ts` uses).
    - `fs.write`: `input: { path: string; content: string }`, `output: { operation: "write"; existed: boolean }`, `permissionAction: "edit"`, `permission(params)` mirrors `write.ts:54-62` (`patterns: [rel], always: ["*"], metadata: { filepath, diff }` — the diff may be `""` since the REPL author is the diff); `run` calls `assertExternalDirectoryEffect` then `FileMutation.writeTextPreservingBom({ target: { canonical, resource }, content })`.
    - `shell.run`: `input: { command: string; cwd?: string; timeoutMs?: number }`, `output: { stdout: string; stderr: string; exitCode: number }`, `permissionAction: "bash"`, `permission(params)` asks `{ permission: "bash", patterns: [<command's first token>], always: ["*"], metadata: { command } }` (first-token extraction mirrors the shell tool's classifier key; keep it simple — split on whitespace); `run` delegates to `deps.shell.run` which the tool layer wires to `ChildProcessSpawner` with the same output-capture semantics as `shell.ts` (stdout/stderr bounded by the REPL's `maxOutputBytes` — see Task 6). `timeoutMs` default 60_000, capped at 600_000.
    - `search_tools`: `input: { query: string }`, `output: { items: Array<{ name: string; namespace: string; description: string }> }`, `permissionAction: "search_tools"`, `readonly: true` (catalog visibility, no `ask` — mirrors the synthesized registry `search_tools`); `run` calls `deps.discover(query)`.
    - `memory_query`: `input: { text: string }`, `output: { records: Array<{ title: string; text: string }> }`, `permissionAction: "memory"`, `readonly: true`; `run` calls `deps.memory.query(text)` (wired to `findRelevantMemories` in Task 6). Read-only, in-process, no network.

- [ ] **Step 1: Write the failing test** — `packages/opencode/test/repl/methods.test.ts`. Build a fixture `HostRpcDeps` (in-memory fs on a `tmpdir`, a shell recorder, a canned discovery, a canned memory store) and assert, for each method, through the Task 2 `dispatch`:
  - `fs.write` then `fs.read` round-trips a file inside the tmpdir;
  - `fs.write` with an `ask` that denies leaves the file absent and returns `permission_denied`;
  - `fs.write` outside the Location root is rejected by `assertExternalDirectoryEffect` (ask receives `external_directory`);
  - `shell.run` records the command, respects `timeoutMs`, and surfaces the exit code;
  - `search_tools` returns the canned items without invoking `ask`;
  - `memory_query` returns the canned records without invoking `ask`.

```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { dispatch, type HostRpcContext } from "@/repl/host"
import { buildHostMethods } from "@/repl/methods"
import { MessageID, SessionID } from "@/session/schema"

function deps(dir: string) {
  const files = new Map<string, string>()
  return {
    fs: {
      readFile: async (p: string) => {
        const text = files.get(p)
        return text === undefined ? undefined : new TextEncoder().encode(text)
      },
      mutation: {
        writeTextPreservingBom: async (input: { target: { canonical: string }; content: string }) => {
          files.set(input.target.canonical, input.content)
          return { operation: "write" as const, target: input.target.canonical, resource: "", existed: files.has(input.target.canonical) }
        },
        create: async (input: any) => input,
        write: async (input: any) => input,
      },
    },
    shell: {
      run: async (input: { command: string }) => ({ stdout: `ran: ${input.command}`, stderr: "", exitCode: 0 }),
    },
    discover: (query: string) => [{ name: "grep", namespace: "system", description: `search for ${query}` }],
    memory: {
      query: async (text: string) => [{ title: "mem", text: text }],
    },
  }
}

describe("repl host methods", () => {
  test("fs.write then fs.read round-trips inside the fixture root", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "repl-methods-"))
    const registry = buildHostMethods(deps(dir))
    const ctx: HostRpcContext = {
      sessionID: SessionID.make("ses_m"),
      messageID: MessageID.make("msg_m"),
      agent: "build",
      callID: "call_m",
      ask: () => Effect.void,
    }
    const target = path.join(dir, "a.txt")
    const w = await Effect.runPromise(dispatch(registry, { id: "1", method: "fs.write", params: { path: target, content: "hello" } }, ctx))
    expect(w.ok).toBe(true)
    const r = await Effect.runPromise(dispatch(registry, { id: "2", method: "fs.read", params: { path: target } }, ctx))
    expect(r).toEqual({ id: "2", ok: true, result: { text: "hello", bytes: 5 } })
  })

  test("denied fs.write leaves the filesystem untouched and returns permission_denied", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "repl-methods-"))
    const registry = buildHostMethods(deps(dir))
    const ctx: HostRpcContext = {
      sessionID: SessionID.make("ses_m"),
      messageID: MessageID.make("msg_m"),
      agent: "build",
      callID: "call_m",
      ask: () => Effect.fail(new Error("denied")),
    }
    const target = path.join(dir, "nope.txt")
    const res = await Effect.runPromise(dispatch(registry, { id: "3", method: "fs.write", params: { path: target, content: "x" } }, ctx))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe("permission_denied")
    expect(await Bun.file(target).exists()).toBe(false)
  })
})
```

(Add the remaining cases — `external_directory`, shell, search_tools, memory_query — following the same shape. The fixture `deps` deliberately avoids mocks; the in-memory fs and recorder are real values.)

- [ ] **Step 2: Run, watch it fail**

Run: `cd packages/opencode && bun test test/repl/methods.test.ts`
Expected: FAIL — module `@/repl/methods` missing.

- [ ] **Step 3: Implement `src/repl/methods.ts`** — `buildHostMethods(deps)` returns the five `HostMethod`s using `Tool.make`-style plain objects. Keep each `run` thin: permission/scope enforcement at the top, service call in the middle, `RpcError` translation at the boundary. Verify against the real `read.ts`/`shell.ts`/`task.ts` ask shapes while implementing (Context File 7); code wins over this excerpt. Use `assertExternalDirectoryEffect` by adapting a minimal `Tool.Context` from `HostRpcContext`.

- [ ] **Step 4: Run, watch it pass** — same command. Then `cd packages/opencode && bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/repl/methods.ts packages/opencode/test/repl/methods.test.ts
git commit -m "feat(opencode): REPL host methods for fs, shell, search_tools, memory"
```

---

### Task 4: `spawn` / `wait` / `send_mailbox` over the RUN-01 scheduler

**Files:**
- Create: `packages/opencode/src/repl/dag.ts`
- Modify: `packages/opencode/src/repl/methods.ts` (add `dag` methods to `buildHostMethods`; make `DagDeps` non-optional)
- Modify: `packages/opencode/src/agent/scheduler-service.ts` (additive: expose the scheduler client for REPL use)
- Create: `packages/opencode/test/repl/dag-methods.test.ts`

**Interfaces:**
- Consumes: RUN-01 produced `Scheduler.waitForTasks`, `WaitTimeoutError`, `UnknownTaskError` (see `TODO/README.md` §7 and RUN-01 Task 5); `createScheduler(client)` (`@ultracode/agents`); `TaskSchedulerAdapter` handle shape (`packages/opencode/src/tool/task.ts:59-65`); `SchedulerClient` (`scheduler-service.ts:27-42`).
- Produces:
  - `export type SpawnHandle = { readonly rootId: string; readonly taskId: string; readonly status: "pending" | "running" | "waiting" | "completed"; readonly summary: string }` — the admission handle returned to the REPL (never the answer).
  - `export type WaitOutcome = { readonly ok: true; readonly outcomes: ReadonlyArray<TaskTerminalOutcome> } | { readonly ok: false; readonly code: "wait_timeout"; readonly pending: string[] }`
  - `export type DagDeps = { readonly spawn: (input: { prompt: string; description: string; subagentType: string; maxTurns: number; maxTokens: number; timeoutMs: number; parentRootId: string; parentTaskId: string; workspaceDirectory?: string }) => Promise<SpawnHandle>; readonly waitForTasks: (input: { taskIds: string[]; timeoutMs: number; pollMs?: number }) => Promise<TaskTerminalOutcome[]>; readonly sendMailbox: (input: { rootId: string; taskId: string; messageId: string; senderTaskId: string; recipientTaskId: string; evidence: { summary: string; artifactIds: string[]; changedPaths: string[] } }) => Promise<void> }`
  - Methods added to `buildHostMethods`:
    - `spawn`: `input: { prompt: string; description?: string; subagentType: string; maxTurns: number; maxTokens: number; timeoutMs: number }`, `output: SpawnHandle`, `permissionAction: "task"`, `permission(params)` mirrors `task.ts:139-145` (`patterns: [subagentType], always: ["*"], metadata: { description, subagentType }`); `run` calls `deps.spawn(...)` with parent = the REPL session's own `{ rootId: ctx.sessionID, taskId: ctx.callID }`. Returns the handle immediately — no waiting.
    - `wait`: `input: { taskIds: string[]; timeoutMs: number }` (timeoutMs ≤ 600_000), `output: WaitOutcome`, `permissionAction: "task"`, `permission(params)` asks `{ permission: "task", patterns: ["*"], always: ["*"], metadata: { wait: true } }`; `run` calls `deps.waitForTasks({ taskIds, timeoutMs })`; on `WaitTimeoutError` returns `{ ok: false, code: "wait_timeout", pending }` — never blocks past the bound.
    - `send_mailbox`: `input: { rootId: string; taskId: string; messageId: string; senderTaskId: string; recipientTaskId: string; evidence: { summary: string; artifactIds?: string[]; changedPaths?: string[] } }`, `output: { ok: true }`, `permissionAction: "task"`, `permission(params)` asks `{ permission: "task", patterns: ["*"], always: ["*"], metadata: { mailbox: true } }`; `run` calls `deps.sendMailbox(...)`.
  - `SchedulerService.Interface` gains `readonly client: Effect<SchedulerClient, Error>` (the existing `SchedulerClient` — additive passthrough; the layer already builds it).

- [ ] **Step 1: Write the failing test** — `packages/opencode/test/repl/dag-methods.test.ts`. Use a real `createScheduler(fakeClient)` (reuse the RUN-01/`ultracode-agents` test fixture style — `listTasks`/`proposeCommit`/`listMailbox`/`listTaskDeliverables` canned in a fake client object; NO module mocks). Wire `deps.spawn = sched.spawn`-equivalent, `deps.waitForTasks = sched.waitForTasks` (present after RUN-01), `deps.sendMailbox = sched.sendMailbox`. Assert:
  1. `spawn` returns an admission handle with `taskId` present and does NOT resolve to a deliverable (fake client records the `task-spawned` commit; assert the response is the handle shape only);
  2. `wait` with a fake client whose `waitForTasks` resolves returns `{ ok: true, outcomes }`;
  3. `wait` with a `waitForTasks` that rejects with `WaitTimeoutError` returns `{ ok: false, code: "wait_timeout", pending: [...] }` and does NOT hang (assert elapsed < timeoutMs + slack);
  4. `send_mailbox` commits a `mailbox-message-sent` with the given evidence (assert the committed event payload).

```ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { dispatch, type HostRpcContext } from "@/repl/host"
import { buildHostMethods, type DagDeps } from "@/repl/methods"
import { MessageID, SessionID } from "@/session/schema"
import { WaitTimeoutError } from "@ultracode/agents"

function deps(overrides: Partial<DagDeps>): DagDeps {
  return {
    spawn: async (input) => ({ rootId: input.parentRootId, taskId: "task-1", status: "pending", summary: input.description }),
    waitForTasks: async (input) => input.taskIds.map((taskId) => ({ taskId, state: "completed" as const })),
    sendMailbox: async () => {},
    ...overrides,
  }
}

describe("repl dag methods", () => {
  const ctx: HostRpcContext = {
    sessionID: SessionID.make("ses_dag"),
    messageID: MessageID.make("msg_dag"),
    agent: "build",
    callID: "call_dag",
    ask: () => Effect.void,
  }

  test("spawn returns an admission handle, never the answer", async () => {
    const registry = buildHostMethods(deps({}))
    const res = await Effect.runPromise(dispatch(registry, {
      id: "1", method: "spawn",
      params: { prompt: "do work", description: "d", subagentType: "explore", maxTurns: 3, maxTokens: 2000, timeoutMs: 60_000 },
    }, ctx))
    expect(res).toEqual({ id: "1", ok: true, result: { rootId: "ses_dag", taskId: "task-1", status: "pending", summary: "d" } })
  })

  test("wait resolves terminal outcomes", async () => {
    const registry = buildHostMethods(deps({}))
    const res = await Effect.runPromise(dispatch(registry, { id: "2", method: "wait", params: { taskIds: ["task-1"], timeoutMs: 2000 } }, ctx))
    expect(res).toEqual({ id: "2", ok: true, result: { ok: true, outcomes: [{ taskId: "task-1", state: "completed" }] } })
  })

  test("wait returns a typed timeout result within the bound", async () => {
    const registry = buildHostMethods(deps({
      waitForTasks: async () => { throw new WaitTimeoutError(["task-9"]) },
    }))
    const started = Date.now()
    const res = await Effect.runPromise(dispatch(registry, { id: "3", method: "wait", params: { taskIds: ["task-9"], timeoutMs: 2000 } }, ctx))
    expect(Date.now() - started).toBeLessThan(2500)
    expect(res).toEqual({ id: "3", ok: true, result: { ok: false, code: "wait_timeout", pending: ["task-9"] } })
  })
})
```

(`WaitTimeoutError` signature per RUN-01 Task 5: `class WaitTimeoutError extends Error { _tag = "WaitTimeoutError"; pending: string[] }` — import it from the produced location, adapt the constructor call to the exact shape the producer lands.)

- [ ] **Step 2: Run, watch it fail** — `cd packages/opencode && bun test test/repl/dag-methods.test.ts`. Expected FAIL: module `@/repl/dag` missing; `WaitTimeoutError` may not exist yet if RUN-01 is incomplete.

- [ ] **Step 3: Implement**
  - `src/repl/dag.ts`: thin adapter that builds `DagDeps` from a `SchedulerClient`:
    `export const dagDepsFromClient = (client: SchedulerClient, workspaceDirectory?: string): DagDeps` — `spawn` maps the REPL input onto `createScheduler(client).spawn` (`key: task:<rootId>:<taskId>:spawn`, `budget: { total: maxTokens, parentAllocation, childPoolAllocation, synthesisReserve }` per `scheduler.ts`'s `BudgetInput` — read `packages/ultracode-agents/src/budget.ts` for the exact shape), returns `{ rootId, taskId, status: "pending", summary: description }`; `waitForTasks` delegates to `sched.waitForTasks`; `sendMailbox` maps evidence onto `sched.sendMailbox`.
  - `src/repl/methods.ts`: add the three methods to `buildHostMethods`, making `DagDeps` non-optional.
  - `scheduler-service.ts`: add `readonly client: Effect<SchedulerClient, Error>` to `Interface`, backed by the already-built client (additive).

- [ ] **Step 4: Run, watch it pass** — same command. Then `cd packages/opencode && bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/repl/dag.ts packages/opencode/src/repl/methods.ts packages/opencode/src/agent/scheduler-service.ts packages/opencode/test/repl/dag-methods.test.ts
git commit -m "feat(opencode): REPL spawn/wait/mailbox over the RUN-01 DAG"
```

---

### Task 5: Persistent per-session namespace + artifact-store snapshot

**Files:**
- Modify: `packages/codemode/src/codemode.ts` (add `makeWithState`, `StatefulRuntime`)
- Modify: `packages/codemode/src/interpreter/runtime.ts` (seed `state` binding; capture readback)
- Create: `packages/codemode/test/state.test.ts`
- Create: `packages/opencode/src/repl/namespace.ts`
- Create: `packages/opencode/test/repl/namespace.test.ts`

**Interfaces:**
- Consumes: `CodeMode.make`/`Result`/`DataValue`/`ExecutionLimits`; `redactSecrets` (`@ultracode/memory`); `EventsClient.putArtifact/openRange/statArtifact` (`@ultracode/events-client`).
- Produces (codemode):
  - `export type StatefulRuntime<R = never> = { readonly catalog: () => ReadonlyArray<ToolDescription>; readonly instructions: () => string; readonly execute: (code: string) => Effect.Effect<{ readonly result: Result; readonly state: DataValue }, never, R> }`
  - `export const makeWithState = <const Tools extends Record<string, unknown> = {}>(options: Options<Tools> & { readonly namespace?: DataValue }): StatefulRuntime<Services<Tools>>` — rejects a non-plain-object `namespace` at construction (`RangeError`); seeds the interpreter's `state` binding with a copy of the current state each execution, reads it back after the run, and carries it forward so consecutive `execute` calls on the same runtime see prior mutations. Returned `state` is always a plain data object (`{}` when untouched).
  - Interpreter change: constructor gains an optional `state` parameter seeding `globalScope.set("state", { mutable: true, value: state })`; `run` captures the resolved `state` binding (top-of-stack down) into an instance field just before its `popScope` finalizer; `readState()` returns it. The public `Result` schema is UNCHANGED (state rides beside it in `StatefulRuntime.execute`'s return).
- Produces (opencode):
  - `export class CodemodeNamespace extends Context.Service<CodemodeNamespace, Interface>()("@opencode/CodemodeNamespace")` with
    - `get(sessionID): DataValue` (live namespace, default `{}`; per-session `Map`),
    - `set(sessionID, state: DataValue): Effect<void>` (must be a plain data object, else `RpcError invalid_params`),
    - `snapshot(sessionID): Effect<{ artifactId: string; scope: string; byteLength: number } | undefined, Error>` — serializes `JSON.stringify(state)`, applies `redactSecrets`, calls `client.putArtifact(bytes, "application/json", scope, "workspace", "plain")`,
    - `restore(sessionID, artifactId): Effect<DataValue, Error>` — `client.openRange(artifactId, scope)` + `JSON.parse`, sets the live namespace, returns it,
    - `reset(sessionID): Effect<void>`.
  - `scope` = `session:<sessionID>` (deterministic, per-session artifact scope).

- [ ] **Step 1: Write the failing tests**

`packages/codemode/test/state.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { CodeMode } from "../src/index"
import { Effect } from "effect"

const make = (namespace?: unknown) =>
  CodeMode.makeWithState({ namespace: namespace as any })

describe("makeWithState", () => {
  test("mutations persist across execute calls on one runtime", async () => {
    const r = make()
    const first = await Effect.runPromise(r.execute("state.count = (state.count ?? 0) + 1; return state.count"))
    expect(first.result.ok && first.result.value).toBe(1)
    expect(first.state).toEqual({ count: 1 })
    const second = await Effect.runPromise(r.execute("return state.count"))
    expect(second.result.ok && second.result.value).toBe(2)
  })

  test("a seeded namespace is visible and round-trips", async () => {
    const r = make({ count: 2, tags: ["a"] })
    const out = await Effect.runPromise(r.execute("state.tags.push('b'); return state.tags"))
    expect(out.result.ok && out.result.value).toEqual(["a", "b"])
    expect(out.state).toEqual({ count: 2, tags: ["a", "b"] })
  })

  test("the host's seeded object is not mutated (seed is a copy)", async () => {
    const host = { count: 1 }
    const r = make(host)
    await Effect.runPromise(r.execute("state.count = 99; return state"))
    expect(host.count).toBe(1)
  })

  test("a non-plain-object namespace is rejected", () => {
    expect(() => make([1, 2])).toThrow(RangeError)
    expect(() => make("nope")).toThrow(RangeError)
  })
})
```

`packages/opencode/test/repl/namespace.test.ts` (fixture client implements `putArtifact`/`openRange`/`statArtifact` against an in-memory map):

```ts
import { describe, expect, test } from "bun:test"
import { CodemodeNamespace } from "@/repl/namespace"
import { SessionID } from "@/session/schema"
import { Effect } from "effect"

function fakeClient() {
  const blobs = new Map<string, Uint8Array>()
  return {
    putArtifact: async (bytes: Uint8Array, mime: string, ownerScope: string) => {
      const id = `art-${blobs.size + 1}`
      blobs.set(`${ownerScope}:${id}`, bytes)
      return { artifact_id: id, mime, byte_length: bytes.byteLength, hash: "" }
    },
    openRange: async (artifactId: string, scope: string) => blobs.get(`${scope}:${artifactId}`) ?? new Uint8Array(),
    statArtifact: async () => null,
  }
}

describe("CodemodeNamespace", () => {
  test("snapshot redacts secrets from the stored bytes", async () => {
    const client = fakeClient()
    const layer = CodemodeNamespace.layer(client as any)
    const sessionID = SessionID.make("ses_ns")
    const run = Effect.gen(function* () {
      const ns = yield* CodemodeNamespace.Service
      yield* ns.set(sessionID, { key: "sk-ABCDEFGHIJKLMNOPQRST", ok: true } as any)
      const snap = yield* ns.snapshot(sessionID)
      expect(snap).not.toBeUndefined()
      const bytes = yield* Effect.promise(() => Promise.resolve(client.openRange(snap!.artifactId, snap!.scope)))
      const text = new TextDecoder().decode(bytes)
      expect(text).not.toContain("sk-ABCDEFGHIJKLMNOPQRST")
      expect(text).toContain("[REDACTED]")
    })
    await Effect.runPromise(run.pipe(Effect.provide(layer)))
  })

  test("restore round-trips a snapshot into a fresh namespace", async () => {
    const client = fakeClient()
    const layer = CodemodeNamespace.layer(client as any)
    const sessionID = SessionID.make("ses_ns2")
    const run = Effect.gen(function* () {
      const ns = yield* CodemodeNamespace.Service
      yield* ns.set(sessionID, { count: 3 })
      const snap = yield* ns.snapshot(sessionID)
      yield* ns.reset(sessionID)
      expect(yield* ns.get(sessionID)).toEqual({})
      const restored = yield* ns.restore(sessionID, snap!.artifactId)
      expect(restored).toEqual({ count: 3 })
    })
    await Effect.runPromise(run.pipe(Effect.provide(layer)))
  })
})
```

- [ ] **Step 2: Run, watch them fail**

Run: `cd packages/codemode && bun test test/state.test.ts` and `cd packages/opencode && bun test test/repl/namespace.test.ts`
Expected: FAIL — `makeWithState` / `CodemodeNamespace` do not exist.

- [ ] **Step 3: Implement**
  - codemode: add `makeWithState` to `codemode.ts` per the Produces contract; add the `state` seed + readback capture in `interpreter/runtime.ts` (seed in the constructor, capture in `run` before `popScope`). Keep the carry-forward on the runtime (`let currentState`) and copy the seed on each execution so the host's object is never mutated. Reuse `copyIn` for validation (`copyIn(namespace, "namespace")` throws on non-plain data).
  - opencode: `namespace.ts` implements the service with a per-session `Map<string, DataValue>`, `JSON.stringify` → `redactSecrets` → `putArtifact`, and `openRange` → `JSON.parse` on restore; expose `CodemodeNamespace.layer(client)` and `CodemodeNamespace.Service` following the repo's Context.Service pattern.

- [ ] **Step 4: Run, watch them pass** — both commands. Then typecheck both packages.

- [ ] **Step 5: Commit**

```bash
git add packages/codemode/src/codemode.ts packages/codemode/src/interpreter/runtime.ts packages/codemode/test/state.test.ts packages/opencode/src/repl/namespace.ts packages/opencode/test/repl/namespace.test.ts
git commit -m "feat(codemode): persistent state runtime with redacted artifact snapshots"
```

---

### Task 6: Promote from experimental — config gate + REPL tool assembly + V2 registry registration + docs

**Files:**
- Create: `packages/core/src/config/codemode.ts`
- Modify: `packages/core/src/config/index.ts` (or wherever `ConfigCompaction` is composed — follow its pattern)
- Create: `packages/opencode/src/repl/engine.ts`
- Create: `packages/opencode/src/repl/v2-registration.ts`
- Modify: `packages/opencode/src/tool/code-mode.ts` (assembly + config gate)
- Modify: `packages/opencode/src/tool/registry.ts` (gate swaps to config)
- Create: `packages/opencode/test/repl/tool.test.ts`

**Interfaces:**
- Consumes: `makeWithState`/`StatefulRuntime` (Task 5); `buildHostMethods`/`HostRpcDeps` (Tasks 3–4); `CodemodeNamespace` (Task 5); `Tools.Service.register` (RUN-03, `packages/core/src/tool/registry.ts:27`); `Tool.make`/`withPermission` (`@opencode-ai/core/tool/tool`); `MCP.Service`; `SchedulerService.Service` (Task 4); `Permission.Service`; `FileMutation.Service`; `ToolDiscovery.search`; `ChildProcessSpawner`; `findRelevantMemories` (`@ultracode/memory`); core `Config.Service` for `codemode.enabled`.
- Produces:
  - Config: `packages/core/src/config/codemode.ts` — `export class Info extends Schema.Class<Info>("ConfigV2.Codemode")({ enabled: Schema.Boolean.pipe(Schema.optional) }) {}` + `export * as ConfigCodemode from "./codemode"`; composed into the config root. Default when unset: **false**.
  - `packages/opencode/src/repl/engine.ts`:
    - `export type ReplEngineDeps = HostRpcDeps & { readonly mcpTools: Record<string, MCP.McpTool>; readonly mcpServers: readonly string[]; readonly namespace: CodemodeNamespace.Interface; readonly sessionID: SessionID; readonly onCall: (entry: { name: string; status: "running" | "completed" | "error" }) => Effect<void> }`
    - `export const createEngine = (deps: ReplEngineDeps): { readonly runtime: StatefulRuntime; readonly run: (code: string) => Effect.Effect<{ result: CodeMode.Result; state: DataValue }, never> }` — builds the codemode tool tree from `mcpTools` (reusing `groupByServer`/`toolTree` from `code-mode.ts` — export them there) plus a `host` namespace exposing the `buildHostMethods` RPC tree; wires `onCall` to the tool-call hooks; `run` seeds from `namespace.get(sessionID)` via `makeWithState`, persists `result.state` back through `namespace.set`, and returns.
  - `packages/opencode/src/repl/v2-registration.ts`:
    - `export const registerCodemodeTool = (engine: ReplEngine): Effect<void, Tool.RegistrationError, Scope.Scope>` — builds a core `Tool.make` (`namespace: "operator"`, `stateChanging: true`, `concurrencySafe: false`, `input: { code: string }`, `output: { output: string; state: Json }`, `toModelOutput` rendering text) whose `execute` runs `engine.run(code)` and is registered via `Tools.Service.register({ execute: withPermission(tool, "codemode") })`. The engine's `ReplEngineDeps` are injected at construction, so the V2 wrapper is exercised with the same fixture deps as the V1 tool.
  - `code-mode.ts`: the tool's `execute` now (a) yields core `Config.Service` and reads `codemode.enabled` (default false), (b) builds the full engine (MCP tools + host RPC methods + namespace) and runs the code, returning `{ title, metadata: { toolCalls }, output, attachments }` as today plus a `state` field in metadata; (c) applies `ExecutionLimits` `maxOutputBytes = 50 * 1024` (mirror `ToolOutputStore.MAX_BYTES`) as the default and `timeoutMs` from the tool params.
  - `registry.ts`: the `execute` tool is registered when `yield* Config.Service` reports `codemode.enabled` is `true` **or** `flags.experimentalCodeMode` is on (back-compat). The env flag remains an alias; the config key is the primary gate.

- [ ] **Step 1: Write the failing tests** — `packages/opencode/test/repl/tool.test.ts`:
  1. config default: build the V1 registry layer with no config → `ids()` does NOT include `execute`;
  2. config `codemode.enabled: true` → `ids()` includes `execute` and the tool executes a confined program;
  3. V2 registration: build a fixture `Tools.Service` layer (RUN-03 harness), `registerCodemodeTool(engine)` with fixture deps, `materialize([], "execute")` → definition present with `namespace: "operator"` and permission action `codemode`; settle a `{ code: "return 1" }` call → structured output `1`;
  4. the engine persists `state` across two tool calls on the same session (mock `CodemodeNamespace` in-memory via the Task 5 service).

```ts
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Tools } from "@opencode-ai/core/tool/tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { registerCodemodeTool } from "@/repl/v2-registration"
import { createEngine } from "@/repl/engine"
import { CodemodeNamespace } from "@/repl/namespace"
import { SessionID } from "@/session/schema"

test("codemode.enabled defaults to false: execute is not registered", async () => {
  // build the V1 ToolRegistry layer with RuntimeFlags.layer({}) and empty Config; assert ids()
  // does not include "execute". Reuse the harness from packages/opencode/test/tool/registry.test.ts.
})

test("V2 registration registers a materializable operator tool", async () => {
  const deps = fixtureDeps() // in-memory namespace + no-op MCP + canned discover/memory
  const engine = createEngine(deps)
  const register = registerCodemodeTool(engine)
  const materialize = Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    yield* register
    const mat = yield* registry.materialize([], "execute")
    return mat
  }).pipe(Effect.provide(Layer.mergeAll(ToolRegistry.node, CodemodeNamespace.layer(fakeClient()))))
  const mat = await Effect.runPromise(materialize)
  expect(mat.definitions.map((d) => d.name)).toContain("execute")
  const def = mat.definitions.find((d) => d.name === "execute")!
  expect(def.metadata.namespace).toBe("operator")
  const settled = await Effect.runPromise(
    mat.settle({ sessionID: SessionID.make("ses_t"), agent: "build" as any, assistantMessageID: "" as any, call: { id: "c", name: "execute", input: { code: "return 1" } } }),
  )
  expect(settled.result.type).toBe("text")
})
```

- [ ] **Step 2: Run, watch them fail** — `cd packages/opencode && bun test test/repl/tool.test.ts`. Expected FAIL: modules missing.

- [ ] **Step 3: Implement** in dependency order: config group → export `groupByServer`/`toolTree` from `code-mode.ts` → `engine.ts` → `v2-registration.ts` → rewire `code-mode.ts` execute → swap the `registry.ts` gate.

- [ ] **Step 4: Run, watch them pass** — same command; then `bun typecheck` in `packages/core` and `packages/opencode`; add a config-reference line for `codemode.enabled` to the config docs file where `compaction`/`memory` keys are documented.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/codemode.ts packages/core/src/config/index.ts packages/opencode/src/repl/engine.ts packages/opencode/src/repl/v2-registration.ts packages/opencode/src/tool/code-mode.ts packages/opencode/src/tool/registry.ts packages/opencode/test/repl/tool.test.ts
git commit -m "feat(opencode): promote codemode to config-gated operator mode with V2 registration"
```

---

### Task 7: Safety conformance tests

**Files:**
- Create: `packages/opencode/test/repl/safety.test.ts`

**Interfaces:**
- Consumes: `createEngine`/`buildHostMethods` (Tasks 3–6); `makeWithState` (Task 5); the fixture deps pattern from Task 3.
- Produces: a pinned safety contract, no new source:
  1. **Escape attempts fail with no side effect**: programs using `eval(`, `globalThis`, `process`, `require`, `import(`, `fetch(`, `Function(`, `Object.prototype` assignment, or `new Worker` each fail with `UnsupportedSyntax`/`UnknownTool`/`InvalidDataValue` diagnostics and leave the fixture fs untouched.
  2. **Permission denial returns a typed error to the REPL with no side effect**: denied `ask` → `permission_denied` response; the fixture fs has no file; `shell` recorder empty.
  3. **Output caps enforced**: a program returning a 200KiB string is truncated with a marker at 50KiB (`truncated: true`), and the full value never reaches the model-facing output; a `maxToolCalls` cap stops runaway tool loops.
  4. **Timeout enforced**: a program that spins (bounded loop) with `timeoutMs: 50` returns `TimeoutExceeded` and never blocks the turn past ~1s.
  5. **State snapshot excludes secrets**: after `ns.set(session, { apiKey: "AKIA1234567890123456" })`, the serialized snapshot bytes contain `[REDACTED]` and not the raw key.
  6. **Host objects are never exposed**: `Object.keys(tools)` returns only the declared namespaces (`host`, MCP servers, `$codemode`); no host function, service, or `Bun` global is reachable from the program.

- [ ] **Step 1: Write the failing tests** — `packages/opencode/test/repl/safety.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { createEngine, type ReplEngineDeps } from "@/repl/engine"
import { CodemodeNamespace } from "@/repl/namespace"
import { SessionID } from "@/session/schema"
import { CodeMode } from "@opencode-ai/codemode"

function safetyDeps(overrides: Partial<ReplEngineDeps> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "repl-safety-"))
  const writes: string[] = []
  return {
    ...baseFixtureDeps(dir), // from test/repl/methods.test.ts pattern: in-memory fs, shell recorder, canned discover/memory, no-op MCP
    writes,
    sessionID: SessionID.make("ses_safety"),
  }
}

describe("repl safety conformance", () => {
  const escapes = [
    "eval('1+1')",
    "globalThis.x = 1",
    "process.exit()",
    "require('fs')",
    "import('fs')",
    "await fetch('https://example.com')",
    "Object.prototype.polluted = true",
  ]

  for (const code of escapes) {
    test(`escape attempt fails without side effects: ${code}`, async () => {
      const deps = safetyDeps()
      const engine = createEngine(deps)
      const { result } = await Effect.runPromise(engine.run(code))
      expect(result.ok).toBe(false)
      expect(deps.writes).toEqual([])
    })
  }

  test("runaway loop is bounded by timeout", async () => {
    const deps = safetyDeps()
    const engine = createEngine(deps)
    const started = Date.now()
    const { result } = await Effect.runPromise(engine.run("while (true) { let x = 1 }"))
    expect(Date.now() - started).toBeLessThan(1000)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("TimeoutExceeded")
  })

  test("oversized result is truncated at the 50KiB cap", async () => {
    const deps = safetyDeps()
    const engine = createEngine(deps)
    const { result } = await Effect.runPromise(engine.run("return 'x'.repeat(200 * 1024)"))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.truncated).toBe(true)
      expect(typeof result.value).toBe("string")
      expect((result.value as string).length).toBeLessThan(60 * 1024)
      expect(result.value as string).not.toContain("x".repeat(200 * 1024))
    }
  })

  test("host namespaces are confined to declared tools", async () => {
    const deps = safetyDeps()
    const engine = createEngine(deps)
    const { result } = await Effect.runPromise(engine.run("return Object.keys(tools).sort()"))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(["$codemode", "host", ...mcpServerNames()].sort())
  })
})
```

- [ ] **Step 2: Run, watch it fail** — `cd packages/opencode && bun test test/repl/safety.test.ts`. Expected FAIL initially (the engine may not yet bound timeouts/byte-caps the way the tests assert) — each failure is a deviation to record and fix forward in this task only if it is a defect in the ENGINE; if it is a defect in the CODEMODE package (e.g. `maxOutputBytes` not applied), fix it in `packages/codemode` with a companion test there.

- [ ] **Step 3: Implement** — only the defects surfaced by the tests, in the owning package, test-first for each. Do not weaken an assertion to make it pass.

- [ ] **Step 4: Run, watch it pass** — same command. Then `cd packages/opencode && bun typecheck` and `cd packages/codemode && bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/test/repl/safety.test.ts
git commit -m "test(opencode): REPL safety conformance (escapes, caps, timeout, redaction)"
```

---

### Task 8: Docs + run ledger

**Files:**
- Create: `packages/opencode/src/repl/README.md` (≤25 lines: what the REPL is, host RPC surface, permission actions, config key, snapshot/redaction invariants)
- Modify: `packages/codemode/README.md` (document `makeWithState`/`state` binding and that state is application-persisted)
- Modify: `TODO/README.md` §7 (tick RUN-11 registry rows: `SchedulerService`/`Scheduler.waitForTasks` consumed; RUN-03 `Tools.Service.register` consumed) and §8 run ledger row
- Modify: this file's Deviation Log

**Interfaces:**
- Consumes: all produced interfaces (Tasks 1–7).

- [ ] **Step 1:** Write the docs; verify every config key named exists in the schema (`rg "codemode" packages/core/src/config`), and the `Scheduler.waitForTasks`/`Tools.Service.register` rows in §7 point at real produced locations.

- [ ] **Step 2:** Commit — `docs(opencode): codemode v2 operator mode notes + run ledger`

---

## Run-Level Review Prompt (dispatch after Task 8)

```
Review commits <list hashes> implementing RUN-11 (opencode/TODO/RUN-11-codemode-v2.md).
Run-specific checks:
1. One-owner: @opencode-ai/codemode remains the only confined code-exec primitive;
   grep the diff for any second REPL/eval/worker code-exec path.
2. Every host RPC method declares a permissionAction and, unless readonly, calls
   the SAME ctx.ask pipeline as native tools; grep the diff for side-effect
   methods that skip ask.
3. spawn returns an admission handle (never a deliverable); wait never blocks
   past timeoutMs and returns pending ids on WaitTimeoutError.
4. State is per-session, snapshot-able, and snapshots pass through redactSecrets
   (no sk-/AKIA/api_key= in stored bytes); redaction cannot be disabled.
5. Output bounded at 2000 lines / 50KiB with a truncation marker; escape
   attempts produce diagnostics with no side effects (safety suite green).
6. Config default-off: with codemode.enabled unset, execute is unregistered and
   the engine is never constructed.
7. The codemode Result schema is unchanged; state rides beside it.
8. V1 freeze: no changes to session/prompt.ts, processor.ts, session.ts.
Then the generic checks from TODO/README.md §5.1 items 1-5.
Reply numbered findings, BLOCKER or MINOR, file:line. No edits.
```

## Deviation Log (fill during execution)

| Task | Deviation | Reason |
|---|---|---|
| All | §18-A3 said "Bun-worker or QuickJS isolate"; reality is an in-process acorn AST interpreter (no eval). Reused as-is, no worker thread. | Code wins over the audit's inference. |
| 1 | (fill) | |
| 6 | `session/tools.ts:397` short-circuit (`if (flags.experimentalCodeMode) return tools`) left unchanged. | V1-loop MCP injection is out of RUN-11 scope; flag kept as an alias. |
