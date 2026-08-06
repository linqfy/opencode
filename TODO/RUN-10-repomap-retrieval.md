# RUN-10: Ranked Repository Map Retrieval into the Context Planner

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship aider-style, deterministic, offline repo-map retrieval as a planner "retrieved evidence" block under the `repository-stable` stability tier — a new `@ultracode/repomap` package that extracts symbol tags with tree-sitter, builds a reference graph, ranks files deterministically (symbol fan-in + watcher recency + stability), and emits a bounded ranked file list; plus the evidence-provider seam in `@ultracode/context` that turns it into a cacheable, SHA-256-fingerprinted `ContextBlock`.

**Architecture:** `@ultracode/repomap` is a new, self-contained domain package (sibling to `@ultracode/memory`, `@ultracode/agents`): `tags.ts` (pure tree-sitter tag extraction), `rank.ts` (pure reference-graph rank), `index.ts` (incremental, mtime-keyed index + renderer), `service.ts` (`RepositoryMap` service object), `config.ts` (typed `retrieval.repoMap` schema). The consumer seam lives in `packages/ultracode-context/src/planner/evidence.ts` and `blocks.ts` (optional `evidence` on `buildSystemPlan`), emitted under `repository-stable` so it lands in the cache-stable prefix and is fingerprinted like every other block. Budget: the caller derives `budgetTokens` from `allocateFlexible(flexibleBudget).evidence` (already shipped in `compiler/budget.ts`). No embeddings, no vector store, no external service — everything runs offline from the working tree.

**Package-vs-module decision (mandatory justification):** a **separate `@ultracode/repomap` package**, not a module inside `ultracode-context`. The planner package is currently `effect`-only and pure; the producer needs `web-tree-sitter` + five grammar packages, a ripgrep adapter, an optional native watcher, and filesystem scanning — none of which belong in the compiler's dependency tree. Domain-package isolation matches every existing sibling (`@ultracode/memory`, `@ultracode/agents`, `@ultracode/events-client`) and keeps the context package's dep tree tiny. The **one-owner rule is about subsystem ownership, not physical location**: retrieval is owned by the context-planner domain; the seam (`planner/evidence.ts`, `planner/index.ts`) is in the context package where the RUN-13 runner reads it, and the `RepositoryMap` producer lives in the repomap package it owns. No second planner, no second ripgrep *tool* adapter (`core`'s `Ripgrep.Service` stays the single owner of model-facing search); repomap's `listFiles` is an internal file-listing concern of the retrieval subsystem.

**Tech Stack:** Bun, TypeScript, web-tree-sitter (WASM), tree-sitter grammars (ts/tsx/js/jsx/py/go/rust), ripgrep `--files`, `@parcel/watcher` (best-effort), Effect-Schema for config, `@ultracode/context` seam.

**Audit basis:** §18-A8 (ranked repo map, resist vector DB), §12 "Repo retrieval" row (you: ripgrep/glob/fff only), §7.1 (semantic repository index missing), §20.11 (recipe-scanner is unrelated; the retrieval row is §7.1/A8/§23.13), §23 P2 #13 (A8 repo-map retrieval into planner evidence blocks), §5.4 (zero semantic retrieval).

## Global Constraints

All constraints in `TODO/README.md` §2 apply verbatim. In addition:

- **Retrieval belongs to the context-planner domain.** The `RepositoryMap` service lives in `@ultracode/repomap`; the evidence seam lives in `@ultracode/context` `src/planner/`; no second planner is created; `packages/opencode` and `packages/core` receive **no** retrieval code this run (RUN-13 wires the runner).
- **Offline-only.** No embeddings, no vector store, no network calls at runtime. ripgrep must come from `OPENCODE_RIPGREP_BIN` or `PATH` (this machine has `/usr/bin/rg` 15.1.0); the tree-sitter grammars are static WASM assets in the new package's dependency tree.
- **Determinism is mandatory.** The evidence block for an unchanged tree + query is byte-identical across builds: sorted output, integer rank arithmetic, no `Date.now()`/wall clock anywhere in the tag→rank→render path (recency comes from watcher **event order**, stability from **mtime order**).
- **Bounded memory.** The index streams file-by-file (parse one file, discard its buffer); in-memory state is per-file metadata (`{path, mtimeMs, size, symbols[], tokenSet-capped}`). Caps: `MAX_TOKENS_PER_FILE`, `MAX_INDEXED_FILES` — a file beyond the cap is never read.
- **No new tree-sitter grammars beyond the five this run adds** (typescript, javascript, python, go, rust). All five ship `.wasm` in the npm tarball; they are **not** added to root `trustedDependencies` (bun skips their `node-gyp-build` install script — we consume only WASM, no native build).
- **No code copied from `../codex`, `../claude-code-sourcemap`, or aider.** The ranking is an original deterministic reimplementation of the *idea* (fan-in + recency + stability); tag node-type sets are authored against the MIT-licensed grammars we vendor as dependencies. Record provenance in the repomap README (Task 7).
- Branch: `repomap-retrieval`.

## Orchestrator Brief

### Context Files (read in full before dispatching Task 1)

1. `packages/ultracode-context/src/compiler/{budget,types,fingerprint,compile}.ts` — budget math (`allocateFlexible` 35/45/15/5, `evidence` share), `BlockStability` six tiers, `ContextBlock`, `compileContext` deterministic ordering + fingerprinting + cache boundary.
2. `packages/ultracode-context/src/blocks.ts` — `buildSystemPlan` TEMPORARY bridge (Stage 3b target); this is where the `evidence` field is added.
3. `packages/ultracode-context/src/planner/{index,types}.ts` and `src/index.ts` — barrel layout and the injected-seam pattern (`SummarizeFn`, `CompactionDeps`) the evidence seam must mirror.
4. `packages/opencode/src/tool/shell.ts` (lines ~311–336) — the exact tree-sitter WASM loading pattern (`Parser.init` + `{ with: { type: "wasm" } }` + `resolveWasm`); `packages/opencode/src/tool/shell.ts:84-89` for `resolveWasm`.
5. `packages/core/src/ripgrep.ts` — the `find`/`glob`/`grep` contract and the exact `rg --files` argument shape (`--no-config --files [--hidden] [--follow] [--glob=pattern] --glob=!**/.git/** .`) and relative-path normalization the index's `listFiles` must match.
6. `packages/core/src/filesystem/search.ts` + `packages/core/src/filesystem/watcher.ts` — `ripgrepLayer`'s `--files` usage; the `@parcel/watcher` binding-resolution trick (`@parcel/watcher-${platform}-${arch}[-libc]`, `createWrapper`) the best-effort watcher replicates.
7. `packages/core/src/ripgrep/binary.ts` — `which("rg")`-first binary resolution (repomap mirrors the first two steps, minus the download).
8. `packages/ultracode-agents/src/{scheduler,types}.ts` — sibling domain-package style: plain promise services (`createScheduler`), typed errors, no Effect coupling.
9. Tests: `ls packages/ultracode-context/test packages/ultracode-agents/test` and read `packages/ultracode-context/test/{budget,compiler,fingerprint}.test.ts` for style (no mocks, tmpdir helpers).

### Baselines (record before Task 1)

```bash
cd /home/thymia/UltraCode-Planning/opencode && bun install   # REQUIRED first: node_modules absent as of 2026-08-06
cd packages/ultracode-context && bun test 2>&1 | tail -5
cd packages/ultracode-context && bun typecheck 2>&1 | tail -3
rg --version    # expect ripgrep 15.1.0 (verified /usr/bin/rg)
which rg
```

Environment notes recorded during planning (2026-08-06): `bun` and `node_modules` are absent in this checkout — the orchestrator must `bun install` before baselines; `rg` 15.1.0 is present on `PATH`; only `tree-sitter-bash`/`tree-sitter-powershell` are vendored today (see Deviation Log D1).

### Dispatch Order

Tasks 1 → 7 strictly sequential. Task 1 bootstraps the new workspace package (requires `bun install` to register it); Task 5 touches `packages/ultracode-context`; Tasks 2–4 and 6 are repomap-internal.

### Definition of Done (verify each with a command you ran)

- [ ] `cd packages/ultracode-repomap && bun test` green (Tasks 1–4, 6 tests).
- [ ] `cd packages/ultracode-repomap && bun typecheck` green.
- [ ] `cd packages/ultracode-context && bun test` green — existing suite plus the new evidence tests.
- [ ] `cd packages/ultracode-context && bun typecheck` green.
- [ ] Byte-compare: `bun test test/planner-integration.test.ts` passes — it asserts the `repo-map` block content AND the `compileContext` prompt fingerprint are byte-identical across two `provide()` calls over an unchanged fixture tree.
- [ ] Fixture-tree build command (`bun run script/demo.ts`) run twice, outputs `diff` to empty: the printed block is deterministic.
- [ ] Evidence budget: the `repo-map` block's `estimatedTokens` never exceeds the `allocateFlexible(...).evidence` share passed in (asserted in `planner-integration.test.ts`).
- [ ] `git status` clean; branch `repomap-retrieval`; one commit per task, only declared files staged.
- [ ] `TODO/README.md` §7 RUN-10 row updated to the final produced symbols (Task 7).

---

### Task 1: Package bootstrap, grammar availability, and ripgrep file-enumeration characterization

**Files:**
- Create: `packages/ultracode-repomap/package.json`, `packages/ultracode-repomap/tsconfig.json`, `packages/ultracode-repomap/src/index.ts`, `packages/ultracode-repomap/src/wasm.ts`, `packages/ultracode-repomap/src/grammars.ts`, `packages/ultracode-repomap/src/files.ts`, `packages/ultracode-repomap/src/errors.ts`
- Create: `packages/ultracode-repomap/test/characterization.test.ts`
- Modify: `bun.lock` + root `package.json` workspace wiring (regenerated by `bun install`, do not hand-edit)

**Interfaces:**
- Consumes: nothing (new package).
- Produces:
  - `packages/ultracode-repomap/src/grammars.ts`: `export type LanguageId = "typescript" | "tsx" | "javascript" | "jsx" | "python" | "go" | "rust"`; `export const SUPPORTED_LANGUAGES: readonly LanguageId[]`; `export const loadLanguage(language: LanguageId): Promise<Parser>` (lazy, memoized per language, web-tree-sitter WASM pattern from `shell.ts`); `export const languageForPath(filePath: string): LanguageId | undefined` (extension table `.ts/.tsx/.js/.jsx/.mjs/.cjs/.py/.go/.rs`); `export const isSupportedPath(filePath: string): boolean`.
  - `packages/ultracode-repomap/src/files.ts`: `export const resolveRg(): string | undefined` (search order: `OPENCODE_RIPGREP_BIN` → `Bun.which("rg")`); `export const listFiles(cwd: string): Promise<string[]>` — spawns `[rg, --no-config, --files, --glob=!**/.git/**, "."]`, returns normalized relative paths (`./` stripped, `\` → `/`), rejects with `RipgrepUnavailableError` (message lists the probed env override + PATH) when no binary.
  - `packages/ultracode-repomap/src/errors.ts`: `export class RepomapError extends Error { readonly _tag = "RepomapError" }`; `export class RipgrepUnavailableError extends RepomapError`.
  - `packages/ultracode-repomap/src/wasm.ts`: `export const resolveWasm(asset: string): string` — the `shell.ts:84-89` helper verbatim-in-spirit.
  - `packages/ultracode-repomap/package.json`: `name: "@ultracode/repomap"`, scripts `test`/`typecheck` matching siblings, `dependencies`: `web-tree-sitter: 0.25.10`, `tree-sitter-typescript: 0.23.2`, `tree-sitter-javascript: 0.25.0`, `tree-sitter-python: 0.25.0`, `tree-sitter-go: 0.25.0`, `tree-sitter-rust: 0.24.0`; `devDependencies`: `@tsconfig/bun`/`@types/bun`/`@typescript/native-preview` (catalog), `@ultracode/context: "workspace:*"` (for Task 5's integration test only). Do **not** add these grammar packages to root `trustedDependencies`.

- [ ] **Step 1: Write the failing test** — `test/characterization.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { listFiles } from "../src/files"
import { loadLanguage, SUPPORTED_LANGUAGES } from "../src/grammars"

const SNIPPETS: Record<string, string> = {
  typescript: "export function add(a: number, b: number) { return a + b }\n",
  tsx: "export const App = () => <div/>\n",
  javascript: "function main() { return 1 }\n",
  jsx: "const el = <div/>\n",
  python: "def greet(name):\n    return name\n",
  go: "package main\nfunc main() {}\n",
  rust: "fn main() {}\n",
}

describe("grammar availability (characterization)", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    test(`loads the ${language} grammar and parses a snippet`, async () => {
      const parser = await loadLanguage(language)
      const tree = parser.parse(SNIPPETS[language])
      expect(tree.rootNode.type).toBeTruthy()
    })
  }
})

describe("ripgrep --files enumeration (characterization)", () => {
  test("returns normalized relative paths and honors ignore rules", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "repomap-files-"))
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1\n")
    writeFileSync(path.join(dir, "b.ts"), "export const b = 2\n")
    writeFileSync(path.join(dir, ".ignore"), "b.ts\n")
    const files = await listFiles(dir)
    expect(files).toContain("a.ts")
    expect(files).not.toContain("b.ts")
    expect(files.every((file) => !file.startsWith("./"))).toBe(true)
  })
})
```

- [ ] **Step 2: Run it, watch it fail** — `cd packages/ultracode-repomap && bun test test/characterization.test.ts` → module `../src/grammars` does not exist.
- [ ] **Step 3: Implement** — scaffold the package (`package.json`, `tsconfig.json` extending `@tsconfig/bun/tsconfig.json` like the context package), `src/wasm.ts`, `src/errors.ts`, `src/grammars.ts` (dynamic-import the grammar `.wasm` per language with `{ with: { type: "wasm" } }` exactly like `shell.ts`, memoized `loadLanguage`), `src/files.ts` (`Bun.spawn` the rg command, collect stdout lines). Then `bun install` from the repo root so the workspace + lockfile pick up the new package and the grammar deps. If any grammar ABI mismatches web-tree-sitter 0.25.10, record the exact version that loads in the Deviation Log and pin it.
- [ ] **Step 4: Run test, watch it pass** — same command as Step 2. Expected: 8 tests pass (7 grammars + 1 enumeration).
- [ ] **Step 5: Typecheck** — `cd packages/ultracode-repomap && bun typecheck`
- [ ] **Step 6: Commit** — `feat(ultracode-repomap): bootstrap package with grammar and ripgrep characterization`

---

### Task 2: Tag extraction module (`src/tags.ts`)

**Files:**
- Create: `packages/ultracode-repomap/src/tags.ts`
- Create: `packages/ultracode-repomap/test/tags.test.ts`
- Modify: `packages/ultracode-repomap/src/index.ts` (barrel export)

**Interfaces:**
- Consumes: `LanguageId`, `loadLanguage` (Task 1).
- Produces:
  - `export type SymbolKind = "function" | "method" | "class" | "interface" | "enum" | "struct" | "type" | "trait" | "module" | "const"`
  - `export interface SymbolTag { readonly name: string; readonly kind: SymbolKind; readonly line: number; readonly column: number }`
  - `export const tagsFromTree(tree: Tree, language: LanguageId): readonly SymbolTag[]` — **pure**; walks the tree pre-order, looking through `export_statement`/`decorated_definition` wrappers, emits one tag per tagged node, then sorts by `(line, column, name)`.
  - `export const extractTags(language: LanguageId, source: string): Promise<readonly SymbolTag[]>` — parses `source` with `loadLanguage(language)` then delegates to `tagsFromTree` (the only async surface).
  - Tagged node types (author against the vendored grammars' node-types; adjust to reality and record in the Deviation Log):
    - ts/tsx/js/jsx: `function_declaration`→function, `generator_function_declaration`→function, `class_declaration`→class, `method_definition`→method, `interface_declaration`→interface, `enum_declaration`→enum, `type_alias_declaration`→type, `lexical_declaration`→const (only when its parent is `program` | `export_statement` | `module`; emit one tag per `variable_declarator`'s `name` field).
    - python: `function_definition`→function, `class_definition`→class (recurse through `decorated_definition`).
    - go: `function_declaration`→function, `method_declaration`→method, `type_spec`→type.
    - rust: `function_item`→function, `struct_item`→struct, `enum_item`→enum, `trait_item`→trait, `type_item`→type, `mod_item`→module.
  - Name extraction: prefer the `name` field via `node.childForFieldName("name")`; fall back to the first named child whose type ends with `identifier`.

- [ ] **Step 1: Write the failing test** — `test/tags.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { extractTags } from "../src/tags"

test("typescript: function, class, method, interface, enum, type", async () => {
  const source = [
    "export function add(a: number, b: number) { return a + b }",
    "export interface Vec { x: number }",
    "export enum Color { Red }",
    "export type Pair<T> = [T, T]",
    "export class Matrix {",
    "  add(other: Matrix) { return other }",
    "}",
    "const TOP = 1",
  ].join("\n")
  const tags = await extractTags("typescript", source)
  expect(tags.map((t) => [t.name, t.kind])).toEqual([
    ["add", "function"],
    ["Vec", "interface"],
    ["Color", "enum"],
    ["Pair", "type"],
    ["Matrix", "class"],
    ["add", "method"],
    ["TOP", "const"],
  ])
})

test("python: def and class, including decorated definitions", async () => {
  const source = "import typing\n\n@dataclass\nclass Point:\n    x: int\n\ndef dist(p: Point) -> float:\n    return 0.0\n"
  const tags = await extractTags("python", source)
  expect(tags.map((t) => [t.name, t.kind])).toEqual([
    ["Point", "class"],
    ["dist", "function"],
  ])
})

test("go: func, method, type", async () => {
  const source = "package p\n\ntype Vec struct{ X int }\n\nfunc (v Vec) Len() int { return 1 }\n\nfunc New() Vec { return Vec{} }\n"
  const tags = await extractTags("go", source)
  expect(tags.map((t) => [t.name, t.kind])).toEqual([
    ["Vec", "type"],
    ["Len", "method"],
    ["New", "function"],
  ])
})

test("rust: fn, struct, enum, trait, mod, type", async () => {
  const source = "mod util;\n\ntype Id = u64;\n\npub struct Point { x: f64 }\n\npub enum Kind { A }\n\npub trait Area { fn area(&self) -> f64 }\n\npub fn main() {}\n"
  const tags = await extractTags("rust", source)
  expect(tags.map((t) => [t.name, t.kind])).toEqual([
    ["util", "module"],
    ["Id", "type"],
    ["Point", "struct"],
    ["Kind", "enum"],
    ["Area", "trait"],
    ["area", "function"],
    ["main", "function"],
  ])
})

test("js/tsx/jsx: arrow-function consts are tagged as const", async () => {
  const source = "export const App = () => <div/>\nconst helper = () => 1\n"
  const tags = await extractTags("jsx", source)
  expect(tags.map((t) => [t.name, t.kind])).toEqual([["App", "const"]])
  expect(tags.map((t) => t.name)).not.toContain("helper")
})

test("empty and unsupported input stay total", async () => {
  expect(await extractTags("typescript", "")).toEqual([])
  expect(await extractTags("python", "  \n  # comment only\n")).toEqual([])
})
```

- [ ] **Step 2:** Run `cd packages/ultracode-repomap && bun test test/tags.test.ts` → fail (module missing).
- [ ] **Step 3:** Implement `tags.ts` — `tagsFromTree` is the pure core (a `walk` helper below the export that recurses with a `kindFor` map and a `nameOf` helper); `extractTags` is a thin parse+delegate. Keep `(line, column, name)` sorting at the end of `tagsFromTree`. The exact tagged-node sets above are the initial authoring — **verify each against the actual grammar node types** while implementing and record any drift in the Deviation Log (fixtures are the source of truth).
- [ ] **Step 4:** Run, watch pass (expected 6 pass). Then `bun typecheck`.
- [ ] **Step 5: Commit** — `feat(ultracode-repomap): deterministic tree-sitter symbol tag extraction`

---

### Task 3: Pure ranking module (`src/rank.ts`)

**Files:**
- Create: `packages/ultracode-repomap/src/rank.ts`
- Create: `packages/ultracode-repomap/test/rank.test.ts`
- Modify: `packages/ultracode-repomap/src/index.ts` (barrel export)

**Interfaces:**
- Consumes: `SymbolTag` (Task 2) conceptually; `rank.ts` operates on `FileProfile` and is fully pure.
- Produces:
  - `export interface FileProfile { readonly path: string; readonly symbols: readonly SymbolTag[]; readonly tokenSet: readonly string[] }` — `tokenSet` = the file's unique identifier tokens (provided by the index; NOT computed here).
  - `export interface ReferenceGraph { readonly fanIn: ReadonlyMap<string, number> }`
  - `export const buildReferenceGraph(files: readonly FileProfile[]): ReferenceGraph` — pure. For each file `F`, for each symbol `S` defined in a different file `G` with `S.name.length >= 2`, if `S.name` is in `F.tokenSet`, add edge `F → G`. `fanIn[G]` = number of distinct referencing files. Self-references excluded.
  - `export interface RankInput { readonly fanIn: ReadonlyMap<string, number>; readonly recencySeq: ReadonlyMap<string, number>; readonly stabilityRank: ReadonlyMap<string, number> }`
  - `export const MAX_RANK_INPUT = 999`
  - `export interface RankedFile { readonly path: string; readonly rank: number; readonly symbols: readonly SymbolTag[]; readonly summary: string }`
  - `export const summarizeFile(path: string, symbols: readonly SymbolTag[]): string` — `<path>: <n> symbol(s): <sym1>, <sym2>, ...` (symbols in emission order, capped at 8, `…` ellipsis when truncated).
  - `export const rankFiles(files: readonly FileProfile[], input: RankInput): readonly RankedFile[]` — pure. `score = fanIn * 10_000 + min(recencySeq, MAX_RANK_INPUT) * 100 + min(stabilityRank, MAX_RANK_INPUT) * 10` (constants `FAN_IN_WEIGHT = 10_000`, `RECENCY_WEIGHT = 100`, `STABILITY_WEIGHT = 10`). Sort by `(score desc, path asc)`. `rank` = the integer score.

- [ ] **Step 1: Write the failing test** — `test/rank.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { buildReferenceGraph, rankFiles, summarizeFile, type FileProfile } from "../src/rank"

const prof = (path: string, symbols: string[], tokenSet: string[]): FileProfile => ({
  path,
  symbols: symbols.map((name) => ({ name, kind: "function", line: 1, column: 1 })),
  tokenSet,
})

const emptyInput = {
  fanIn: new Map<string, number>(),
  recencySeq: new Map<string, number>(),
  stabilityRank: new Map<string, number>(),
}

describe("buildReferenceGraph", () => {
  test("counts distinct referencing files per symbol-owning file", () => {
    const files = [
      prof("a.ts", ["a"], ["b", "c"]),
      prof("b.ts", ["b"], ["c"]),
      prof("c.ts", ["c"], ["a"]),
    ]
    const graph = buildReferenceGraph(files)
    expect(graph.fanIn.get("c.ts")).toBe(2)
    expect(graph.fanIn.get("a.ts")).toBe(1)
    expect(graph.fanIn.get("b.ts")).toBe(1)
  })

  test("a file never references its own symbols", () => {
    const files = [prof("a.ts", ["a"], ["a", "b"]), prof("b.ts", ["b"], ["a"])]
    const graph = buildReferenceGraph(files)
    expect(graph.fanIn.get("a.ts")).toBe(1)
    expect(graph.fanIn.get("b.ts")).toBe(0)
  })

  test("one- and two-character symbol names do not count as references", () => {
    const files = [prof("a.ts", ["x", "aa"], ["x", "aa"]), prof("b.ts", ["b"], ["x"])]
    const graph = buildReferenceGraph(files)
    expect(graph.fanIn.get("a.ts")).toBe(0)
  })
})

describe("rankFiles", () => {
  test("rank is integer, deterministic, and ties break by path ascending", () => {
    const files = [
      prof("b.ts", ["b"], []),
      prof("a.ts", ["a"], ["b"]),
      prof("c.ts", ["c"], ["a", "b"]),
    ]
    const graph = buildReferenceGraph(files)
    const ranked = rankFiles(files, { ...emptyInput, fanIn: graph.fanIn })
    expect(ranked.map((f) => f.path)).toEqual(["c.ts", "a.ts", "b.ts"])
    expect(ranked[0]?.rank).toBe(2 * 10_000)
    expect(ranked[1]?.rank).toBe(1 * 10_000)
    expect(ranked[2]?.rank).toBe(1 * 10_000)
  })

  test("recency and stability add deterministic weighted terms", () => {
    const files = [prof("x.ts", [], []), prof("y.ts", [], [])]
    const ranked = rankFiles(files, {
      fanIn: new Map([["x.ts", 3], ["y.ts", 0]]),
      recencySeq: new Map([["x.ts", 2]]),
      stabilityRank: new Map([["y.ts", 7]]),
    })
    expect(ranked[0]?.path).toBe("x.ts")
    expect(ranked[0]?.rank).toBe(3 * 10_000 + 2 * 100)
    expect(ranked[1]?.rank).toBe(7 * 10)
  })

  test("identical scores fall back to path order for byte-stable output", () => {
    const files = [prof("z.ts", [], []), prof("a.ts", [], [])]
    const ranked = rankFiles(files, emptyInput)
    expect(ranked.map((f) => f.path)).toEqual(["a.ts", "z.ts"])
  })
})

describe("summarizeFile", () => {
  test("caps the symbol list at eight with an ellipsis", () => {
    const symbols = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((name) => ({
      name, kind: "function" as const, line: 1, column: 1,
    }))
    expect(summarizeFile("x.ts", symbols)).toBe("x.ts: 9 symbols: a, b, c, d, e, f, g, h, …")
  })
})
```

- [ ] **Step 2:** Run `cd packages/ultracode-repomap && bun test test/rank.test.ts` → fail (module missing).
- [ ] **Step 3:** Implement `rank.ts` — pure functions only; `buildReferenceGraph` builds a `Map<symbolName, owningPath>` then a single pass per file; `rankFiles` computes integer scores and sorts `(score desc, path asc)`. No `Date`, no imports beyond `SymbolTag`.
- [ ] **Step 4:** Run, watch pass (expected 8 pass). Then `bun typecheck`.
- [ ] **Step 5: Commit** — `feat(ultracode-repomap): deterministic reference-graph ranking`

---

### Task 4: Incremental index, cache, renderer, and bounded output (`src/index.ts`, `src/render.ts`)

**Files:**
- Create: `packages/ultracode-repomap/src/render.ts`
- Create: `packages/ultracode-repomap/src/index.ts`
- Create: `packages/ultracode-repomap/src/watcher.ts`
- Create: `packages/ultracode-repomap/test/index.test.ts`
- Modify: `packages/ultracode-repomap/src/index.ts` (barrel export)

**Interfaces:**
- Consumes: `listFiles` (Task 1), `extractTags` (Task 2), `buildReferenceGraph`/`rankFiles`/`summarizeFile` (Task 3), `languageForPath` (Task 1).
- Produces:
  - `packages/ultracode-repomap/src/render.ts`:
    - `export const estimateTokens(text: string): number` — `Math.ceil(text.length / 4)`, the same 4-chars/token rule as `@ultracode/context`'s `blocks.ts` (duplicated by intent; the seam recomputes on the context side).
    - `export interface RenderedMap { readonly content: string; readonly truncated: boolean }`
    - `export const renderRepoMap(files: readonly RankedFile[]): RenderedMap` — deterministic: header line `# Repository Map` then one line per file in the input order (already ranked): `<summary>`. `truncated: false`.
    - `export const fitBudget(map: RenderedMap, budgetTokens: number): RenderedMap` — deterministic truncation: while `estimateTokens(content) > budgetTokens`, repeatedly drop the last symbol from the currently longest symbol-list line (ties: the first such line), turning its ellipsis back on; if still over and no symbols remain, drop trailing lines (lowest-ranked). `truncated: true` iff anything was dropped.
  - `packages/ultracode-repomap/src/watcher.ts` (best-effort):
    - `export const hasNativeBinding(): boolean` — replicates `core/src/filesystem/watcher.ts`'s `@parcel/watcher-${platform}-${arch}[-libc]` resolution inside a guard; `false` on any failure.
    - `export type WatchEvent = { readonly path: string; readonly type: "create" | "update" | "delete" }`
    - `export const watch(cwd: string, onEvent: (event: WatchEvent) => void): Promise<(() => Promise<void>) | undefined>` — dynamic-imports `@parcel/watcher` (optional dep); returns an unsubscribe fn, or `undefined` when no native binding.
  - `packages/ultracode-repomap/src/index.ts`:
    - `export const MAX_TOKENS_PER_FILE = 4_000`, `export const MAX_INDEXED_FILES = 50_000`
    - `export interface CachedFile { readonly path: string; readonly mtimeMs: number; readonly size: number; readonly profile: FileProfile }`
    - `export interface IndexSnapshot { readonly files: readonly RankedFile[] }`
    - `export interface RepoMapResult { readonly files: readonly RankedFile[]; readonly content: string; readonly estimatedTokens: number; readonly truncated: boolean }`
    - `export class RepositoryMap` with `refresh(opts?: { readonly onParse?: (path: string) => void }): Promise<void>` (incremental: re-list via `listFiles`; per file stat `mtimeMs`+`size`; re-parse only when either differs from the cache; drop deleted files; enforce `MAX_INDEXED_FILES` — files beyond the cap sorted by path are never read; tokenize content with `MAX_TOKENS_PER_FILE` cap) and `provide(query: { readonly cwd: string; readonly budgetTokens: number; readonly maxFiles: number }): Promise<RepoMapResult>` (refreshes if dirty, builds `stabilityRank` from `(mtimeMs asc, path asc)` positions capped at `MAX_RANK_INPUT`, ranks, slices to `maxFiles`, renders, fits budget) and `dispose(): Promise<void>` (unsubscribes watcher).
    - `export const createRepositoryMap(cwd: string, opts?: { readonly config?: RepoMapConfig; readonly recency?: ReadonlyMap<string, number>; readonly onParse?: (path: string) => void }): Promise<RepositoryMap>` — mirrors sibling `createScheduler` style; `config` consumed in Task 6; `recency` is an injectable event-seq map (0 when absent) used by the watcher path; `onParse` is the parse-observer seam.
    - A private `dirty: boolean` set by a registered watcher subscription (create/update/delete → mark dirty + bump that file's recency seq, monotonically increasing, **event order, not timestamps**).

- [ ] **Step 1: Write the failing test** — `test/index.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRepositoryMap, MAX_TOKENS_PER_FILE } from "../src/index"

const query = { cwd: "", budgetTokens: 4_500, maxFiles: 20 }

test("indexes a tree, ranks by fan-in, and renders a deterministic block", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "repomap-idx-"))
  writeFileSync(path.join(dir, "a.ts"), "export const a = 1\n")
  writeFileSync(path.join(dir, "b.ts"), "import { a } from './a'\nconst b = a + 1\n")
  const rm = await createRepositoryMap(dir)
  const result = await rm.provide({ ...query, cwd: dir })
  expect(result.files[0]?.path).toBe("a.ts")
  expect(result.content).toContain("# Repository Map")
  expect(result.content).toContain("a.ts:")
  expect(result.estimatedTokens).toBeLessThanOrEqual(query.budgetTokens)
  await rm.dispose()
})

test("incremental rebuild reparses only the changed file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "repomap-incr-"))
  writeFileSync(path.join(dir, "a.ts"), "export const a = 1\n")
  writeFileSync(path.join(dir, "b.ts"), "export const b = 2\n")
  const seen: string[] = []
  const rm = await createRepositoryMap(dir, { onParse: (p) => seen.push(p) })
  await rm.refresh()
  expect(seen.sort()).toEqual(["a.ts", "b.ts"])
  seen.length = 0
  writeFileSync(path.join(dir, "a.ts"), "export const aLongerValue = 123456\n")
  await rm.refresh()
  expect(seen).toEqual(["a.ts"])
  await rm.dispose()
})

test("deleted files disappear and added files appear on refresh", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "repomap-adddel-"))
  writeFileSync(path.join(dir, "keep.ts"), "export const keep = 1\n")
  writeFileSync(path.join(dir, "gone.ts"), "export const gone = 1\n")
  const rm = await createRepositoryMap(dir)
  await rm.refresh()
  writeFileSync(path.join(dir, "fresh.ts"), "export const fresh = 1\n")
  rm.debugRemoveForTest("gone.ts")
  await rm.refresh()
  const result = await rm.provide({ ...query, cwd: dir })
  expect(result.files.map((f) => f.path).sort()).toEqual(["fresh.ts", "keep.ts"])
  await rm.dispose()
})

test("maxFiles caps the emitted list", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "repomap-cap-"))
  for (let i = 0; i < 6; i++) writeFileSync(path.join(dir, `f${i}.ts`), `export const v${i} = ${i}\n`)
  const rm = await createRepositoryMap(dir)
  const result = await rm.provide({ ...query, cwd: dir, maxFiles: 3 })
  expect(result.files.length).toBe(3)
  await rm.dispose()
})

test("token sets are capped so a single file cannot dominate memory", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "repomap-tokens-"))
  const many = Array.from({ length: MAX_TOKENS_PER_FILE + 50 }, (_, i) => `const v${i} = ${i}`).join("\n")
  writeFileSync(path.join(dir, "big.ts"), many + "\n")
  const rm = await createRepositoryMap(dir)
  await rm.refresh()
  const result = await rm.provide({ ...query, cwd: dir })
  expect(result.content.length).toBeGreaterThan(0)
  await rm.dispose()
})
```

Note for the subagent: the delete-path test calls `debugRemoveForTest(path)` — a documented test-only seam on the class (applies a synthetic "delete" event through the same `applyChange` used by the watcher), so the deletion path is tested without spawning a native watcher. Keep the public surface to `refresh`/`provide`/`dispose` plus that single documented seam. `provide` must run a full rank/render each call (pure, cheap) so two `provide` calls on an unchanged tree return byte-identical `content`.

- [ ] **Step 2:** Run `cd packages/ultracode-repomap && bun test test/index.test.ts` → fail (module missing).
- [ ] **Step 3:** Implement `render.ts`, `watcher.ts`, `index.ts` — change detection is `(mtimeMs !== cached.mtimeMs || size !== cached.size)`; tokenize with a `[A-Za-z_][A-Za-z0-9_]*` word scan capped at `MAX_TOKENS_PER_FILE`; `stabilityRank` = position in the `(mtimeMs asc, path asc)` sort capped at `MAX_RANK_INPUT`. The watcher is wired but optional: `createRepositoryMap` attempts `watch(cwd, ...)` and no-ops when it returns `undefined`. Do not read file contents except inside `parseFile` (parse, derive symbols+tokenSet, discard buffer).
- [ ] **Step 4:** Run, watch pass (expected 5 pass). Then `bun typecheck`.
- [ ] **Step 5: Commit** — `feat(ultracode-repomap): incremental mtime-keyed index with deterministic rendering`

---

### Task 5: Planner evidence seam + `repository-stable` block emission

**Files:**
- Modify: `packages/ultracode-context/src/planner/evidence.ts` (create)
- Modify: `packages/ultracode-context/src/planner/index.ts` (barrel export)
- Modify: `packages/ultracode-context/src/blocks.ts` (`SystemPlanInput` + `buildSystemPlan`)
- Create: `packages/ultracode-repomap/test/planner-integration.test.ts` (in the repomap package; devDep on `@ultracode/context` from Task 1)
- Modify: `packages/ultracode-context/README.md` (evidence seam note)

**Interfaces:**
- Consumes: `RepoMapResult` shape from repomap (structural), `allocateFlexible` (compiler/budget), `ContextBlock`/`BlockStability` (compiler/types), `estimateTokens` (blocks.ts).
- Produces (in `@ultracode/context`):
  - `packages/ultracode-context/src/planner/evidence.ts`:
    - `export interface EvidenceQuery { readonly cwd: string; readonly budgetTokens: number; readonly maxFiles: number }`
    - `export interface RepoMapFile { readonly path: string; readonly symbols: readonly string[]; readonly rank: number; readonly summary: string }` — structurally identical to repomap's `RankedFile` (names + `summary`); no import across packages.
    - `export interface EvidenceBlock { readonly files: readonly RepoMapFile[]; readonly content: string; readonly estimatedTokens: number; readonly truncated: boolean }`
    - `export type EvidenceProviderFn = (query: EvidenceQuery) => Promise<EvidenceBlock> | EvidenceBlock` — the injected seam, mirroring `SummarizeFn`.
    - `export const repoMapEvidenceBlock(evidence: EvidenceBlock): ContextBlock` — `{ id: "repo-map", stability: "repository-stable", trust: "privileged", content: evidence.content, estimatedTokens: estimateTokens(evidence.content), provenance: "repomap", inclusionReason: "retrieved-evidence" }`.
  - `packages/ultracode-context/src/blocks.ts`: `SystemPlanInput` gains `readonly evidence?: EvidenceBlock`; `buildSystemPlan` emits `repoMapEvidenceBlock(input.evidence)` after the instructions blocks when present.
- Consumes from repomap (structural): `RepoMapResult` must be assignable to `EvidenceBlock` (`RepoMapFile` must be assignable to `RankedFile`).

- [ ] **Step 1: Write the failing test** — `packages/ultracode-repomap/test/planner-integration.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { allocateFlexible, buildSystemPlan, compileContext } from "@ultracode/context"
import { createRepositoryMap } from "../src/index"

const budgetTokens = allocateFlexible(100_000).evidence

function fixtureTree() {
  const dir = mkdtempSync(path.join(tmpdir(), "repomap-plan-"))
  writeFileSync(path.join(dir, "lib.ts"), "export const max = (a: number, b: number) => (a > b ? a : b)\n")
  writeFileSync(path.join(dir, "main.ts"), "import { max } from './lib'\nconsole.log(max(1, 2))\n")
  writeFileSync(path.join(dir, "util.py"), "def clamp(v, lo, hi):\n    return max(lo, min(v, hi))\n")
  return dir
}

test("unchanged repo produces a byte-identical repo-map block and prompt fingerprint across two builds", async () => {
  const dir = fixtureTree()
  const rm = await createRepositoryMap(dir)
  const query = { cwd: dir, budgetTokens, maxFiles: 10 }
  const first = await rm.provide(query)
  const second = await rm.provide(query)
  expect(second.content).toBe(first.content)
  expect(second.estimatedTokens).toBe(first.estimatedTokens)

  const planFor = (evidence: typeof first) =>
    buildSystemPlan({
      environment: [],
      instructions: [],
      evidence,
      modelContextLimit: 200_000,
      outputReserve: 20_000,
      userContentTokens: 0,
    })
  const compiledA = compileContext(planFor(first))
  const compiledB = compileContext(planFor(second))
  expect(compiledB.fingerprint).toBe(compiledA.fingerprint)
  await rm.dispose()
})

test("repo-map block occupies the repository-stable tier and respects the evidence budget", async () => {
  const dir = fixtureTree()
  const rm = await createRepositoryMap(dir)
  const evidence = await rm.provide({ cwd: dir, budgetTokens, maxFiles: 10 })
  const compiled = compileContext(
    buildSystemPlan({
      environment: [],
      instructions: [],
      evidence,
      modelContextLimit: 200_000,
      outputReserve: 20_000,
      userContentTokens: 0,
    }),
  )
  const block = compiled.blocks.find((b) => b.id === "repo-map")
  expect(block?.stability).toBe("repository-stable")
  expect(block?.provenance).toBe("repomap")
  expect(block ? block.tokens : 0).toBeLessThanOrEqual(budgetTokens)
  expect(block?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  await rm.dispose()
})

test("disabled or empty evidence emits no repo-map block", async () => {
  const compiled = compileContext(
    buildSystemPlan({ environment: [], instructions: [], modelContextLimit: 200_000, outputReserve: 20_000, userContentTokens: 0 }),
  )
  expect(compiled.blocks.find((b) => b.id === "repo-map")).toBeUndefined()
})
```

- [ ] **Step 2:** Run `cd packages/ultracode-repomap && bun test test/planner-integration.test.ts` → fail (`@ultracode/context` has no `planner/evidence` exports; `SystemPlanInput` has no `evidence`).
- [ ] **Step 3:** Implement the seam in `@ultracode/context` (`planner/evidence.ts`, barrel export, `blocks.ts` optional field) and export the repomap `RepoMapResult`/`RankedFile` shapes so they are structurally assignable to `EvidenceBlock`/`RepoMapFile` (record any field-name drift in the Deviation Log).
- [ ] **Step 4:** Run, watch pass (expected 3 pass). Then `cd packages/ultracode-context && bun typecheck` AND `cd packages/ultracode-repomap && bun typecheck`.
- [ ] **Step 5: Commit** — `feat(ultracode-context): retrieved-evidence repo-map block under repository-stable tier`

---

### Task 6: Config schema, enablement, and the `RepositoryMap` service

**Files:**
- Create: `packages/ultracode-repomap/src/config.ts`
- Modify: `packages/ultracode-repomap/src/service.ts` (create) + `src/index.ts` (barrel)
- Create: `packages/ultracode-repomap/test/config.test.ts`

**Interfaces:**
- Consumes: `RepositoryMap` (Task 4), `RepoMapResult`.
- Produces:
  - `packages/ultracode-repomap/src/config.ts`:
    - `export interface RepoMapConfig { readonly enabled: boolean; readonly maxTokens: number; readonly maxFiles: number }` — the `retrieval.repoMap` surface (`{ enabled?, maxTokens?, maxFiles? }`).
    - `export const DEFAULT_REPOMAP_CONFIG: RepoMapConfig = { enabled: true, maxTokens: 2_000, maxFiles: 20 }`
    - `export const resolveRepoMapConfig(partial?: Partial<RepoMapConfig>): RepoMapConfig` — pure merge over defaults.
  - `packages/ultracode-repomap/src/service.ts`:
    - `export interface RepositoryMap` — the service object type (the RUN-10 `RepositoryMap.Service`; one owner = this package, per the context-planner-domain rule).
    - `export const createRepositoryMap(cwd: string, opts?: { readonly config?: RepoMapConfig; readonly recency?: ReadonlyMap<string, number>; readonly onParse?: (path: string) => void }): Promise<RepositoryMap>` — when `config.enabled === false`, `provide()` resolves to `{ files: [], content: "", estimatedTokens: 0, truncated: false }` without touching the tree; otherwise behaves as Task 4, with `maxFiles` and `budgetTokens` capped at `config.maxFiles`/`config.maxTokens` when the caller's query leaves them undefined.
    - Note: the opencode config **registry** binding (`opencode.json` key `retrieval.repoMap.*`) is deliberately deferred to RUN-13's runner wiring; this task owns the schema + defaults + enablement contract. Record that in the §7 registry row.
- Config-wiring test = decode + merge + enablement, all against the real schema (no opencode stack).

- [ ] **Step 1: Write the failing test** — `test/config.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_REPOMAP_CONFIG, resolveRepoMapConfig } from "../src/config"
import { createRepositoryMap } from "../src/service"

describe("resolveRepoMapConfig", () => {
  test("defaults apply when nothing is given", () => {
    expect(resolveRepoMapConfig()).toEqual(DEFAULT_REPOMAP_CONFIG)
  })

  test("user overrides merge over defaults", () => {
    expect(resolveRepoMapConfig({ enabled: false, maxFiles: 5 })).toEqual({
      enabled: false,
      maxTokens: 2_000,
      maxFiles: 5,
    })
  })

  test("rejects unknown keys (typed surface)", () => {
    expect(() => resolveRepoMapConfig({ nope: true } as never)).toThrow()
  })
})

describe("RepositoryMap enablement", () => {
  test("disabled config returns empty evidence without reading the tree", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "repomap-disabled-"))
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1\n")
    const rm = await createRepositoryMap(dir, { config: resolveRepoMapConfig({ enabled: false }) })
    const result = await rm.provide({ cwd: dir, budgetTokens: 1_000, maxFiles: 5 })
    expect(result.content).toBe("")
    expect(result.files).toEqual([])
    expect(result.truncated).toBe(false)
    await rm.dispose()
  })

  test("defaults cap maxFiles when the query omits it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "repomap-defaultcap-"))
    for (let i = 0; i < 8; i++) writeFileSync(path.join(dir, `f${i}.ts`), `export const v${i} = ${i}\n`)
    const rm = await createRepositoryMap(dir)
    const result = await rm.provide({ cwd: dir, budgetTokens: 10_000 })
    expect(result.files.length).toBeLessThanOrEqual(DEFAULT_REPOMAP_CONFIG.maxFiles)
    await rm.dispose()
  })
})
```

- [ ] **Step 2:** Run `cd packages/ultracode-repomap && bun test test/config.test.ts` → fail (modules missing).
- [ ] **Step 3:** Implement `config.ts` and `service.ts` (move the `createRepositoryMap` factory from Task 4's `index.ts` into `service.ts`, re-export from the barrel; keep `RepositoryMap` class internals in `index.ts`). The `nope` rejection is enforced structurally by the `Partial<RepoMapConfig>` type at compile time; the runtime guard that throws on unknown keys is a small `assertKnownKeys` helper so the runtime `as never`-cast test passes honestly.
- [ ] **Step 4:** Run, watch pass (expected 5 pass). Then `bun typecheck`.
- [ ] **Step 5: Commit** — `feat(ultracode-repomap): retrieval config schema and service enablement`

---

### Task 7: Demo command, docs, and interface registry

**Files:**
- Create: `packages/ultracode-repomap/script/demo.ts` (fixture-tree build command)
- Create: `packages/ultracode-repomap/README.md`
- Modify: `packages/ultracode-context/README.md` (evidence seam)
- Modify: `TODO/README.md` §7 RUN-10 row (final produced symbols)

**Interfaces:** Consumes everything; produces documentation + a command-verifiable DoD artifact.

- [ ] **Step 1: Write the failing script** — `script/demo.ts`: creates a deterministic fixture tree in `Bun.env["REPOMAP_DEMO_DIR"] ?? (tmpdir + "repomap-demo-")` (three TS files: `lib.ts`, `main.ts` importing it, `types.ts`; one Python file), builds the map via `createRepositoryMap`, prints the block with a trailing `----map-fingerprint---- <sha256>` line (reuse `createHash` from `node:crypto` over the content). Run it twice into two files and assert with `diff`. The "test" is the scripted assertion:
  ```bash
  cd packages/ultracode-repomap
  bun run script/demo.ts > /tmp/repomap-demo-1.txt
  bun run script/demo.ts > /tmp/repomap-demo-2.txt
  diff /tmp/repomap-demo-1.txt /tmp/repomap-demo-2.txt   # must be empty
  rg -c "repo-map|Repository Map" /tmp/repomap-demo-1.txt   # must be ≥1
  ```
- [ ] **Step 2:** Run the three commands above; the diff must be empty. If not, fix determinism (suspect wall-clock, unsorted map iteration, or object-key order) — do not weaken the check.
- [ ] **Step 3:** Write `packages/ultracode-repomap/README.md`: purpose, offline determinism contract, `retrieval.repoMap` config keys, memory caps, provenance note (aider *idea* reimplemented deterministically; tag node-type sets authored against the vendored MIT grammars; nothing copied from `../codex`/`../claude-code-sourcemap`).
- [ ] **Step 4:** Update `packages/ultracode-context/README.md` (evidence seam under the Stage-3b note) and `TODO/README.md` §7 RUN-10 row with the final produced symbols (`EvidenceProviderFn`, `EvidenceBlock`, `repoMapEvidenceBlock`, `RepositoryMap`, `createRepositoryMap`, `resolveRepoMapConfig`, `RepoMapConfig`) and their locations; note "opencode config registry binding lands in RUN-13".
- [ ] **Step 5: Commit** — `docs(ultracode-repomap): demo command, determinism contract, and interface registry`

---

## Run-Level Review Prompt (dispatch after Task 7)

```
Review the commits <list hashes> in /home/thymia/UltraCode-Planning/opencode
implementing RUN-10 (file: opencode/TODO/RUN-10-repomap-retrieval.md).
Run-specific checks:
1. One-owner rule: the evidence seam lives only in packages/ultracode-context/src/planner/;
   the RepositoryMap producer only in packages/ultracode-repomap/; no retrieval code in
   packages/opencode or packages/core; core's Ripgrep.Service is untouched.
2. Determinism: grep the diff for Date.now/performance.now/clock reads on the tag->rank->render
   path; the block content depends only on the tree + query. Recency derives from event ORDER.
3. Offline-only: no fetch/http/embeddings/vector store in the diff.
4. Bounded memory: the index never holds file contents; caps MAX_TOKENS_PER_FILE and
   MAX_INDEXED_FILES exist and are enforced.
5. Budget: the repo-map block estimatedTokens <= the evidence share passed in, asserted in a test.
6. Grammars: only the five declared packages were added; they are NOT in root trustedDependencies.
7. Diff scope: only files declared in the run plan.
Then the generic checks from TODO/README.md §5.1 items 1-5.
Reply numbered findings, BLOCKER or MINOR, file:line. No edits.
```

## Deviation Log (fill during execution)

| Task | Deviation | Reason |
|---|---|---|
| Planning | Only `tree-sitter-bash`/`tree-sitter-powershell` are vendored (`packages/opencode/package.json:147-153`); **no** ts/js/py/go/rust grammar exists in `bun.lock`. RUN-10 therefore adds five grammar packages to `@ultracode/repomap` (typescript 0.23.2, javascript 0.25.0, python 0.25.0, go 0.25.0, rust 0.24.0), all shipping static `.wasm`. | D1 — the run's core deliverable is impossible without them; pure WASM assets, no native build, MIT licensed, consistent with the already-trusted tree-sitter family. |
| Planning | `bun` and `node_modules` are absent in this checkout (2026-08-06); `rg` 15.1.0 at `/usr/bin/rg`. Baselines require `bun install` first. | D2 — planning-time environment observation; orchestrator must install before Task 1. |
| Planning | `packages/ultracode-context` is named `@ultracode/context`; `blocks.ts` lives at `src/blocks.ts` (not `src/compiler/blocks.ts`). | D3 — plan excerpts use the real paths. |
| Planning | RUN-05 (planner budget/diagnostics) is not yet started; `CapabilityProfile` does not exist. RUN-10 only consumes the already-shipped `allocateFlexible` evidence share (`compiler/budget.ts:21`), so it is fully self-contained. | D4 — mandated by the run brief. |
| Planning | `allocatedFlexible`'s `evidence` share has no existing consumer; the opencode config registry binding for `retrieval.repoMap` is deferred to RUN-13. | D5 — V1 config stack is frozen; runtime wiring is RUN-13's scope. |
| (add rows as subagents report) | | |
