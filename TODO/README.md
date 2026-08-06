# UltraCode Orchestrated Implementation Runs

This directory is the execution plan for the architectural program described in
`../../ARCHITECTURAL-AUDIT.md` (the "audit"). Each `RUN-*.md` file is one
orchestrated run: a self-contained TDD plan for a fresh subagent-driven session.

**Orchestrator: read this file in full before starting any run.**
Then read the run file in full. Only then dispatch subagents.

---

## 1. Run Order And Dependencies

Runs are ordered. Never start a run whose dependencies are not marked DONE in
the run ledger (§8). Within a run, tasks execute strictly in order.

| Run | Title | Depends on | Priority |
|---|---|---|---|
| RUN-01 | Sidecar packaging, supervision, DAG interaction primitives | — | P0 |
| RUN-02 | Memory wiring (context source, extraction, review) | RUN-01 | P0 |
| RUN-03 | V2 tool discovery + plugin/MCP tool registration | — | P0 |
| RUN-04 | Staged compaction, typed checkpoints, snapshots, cache-edit microcompact, conformance | — | P0/P1 |
| RUN-05 | Capability profiles at runtime, budget spine, diagnostics instrumentation | RUN-04 | P0 |
| RUN-06 | Unified approval pipeline: policy, amendments, review lane, decisions, role models | — | P1 |
| RUN-07 | Agent experiments: rollback checkpoints + unified rewind | RUN-01 | P1 |
| RUN-08 | Streaming-parallel tool execution + speculative permission eval | RUN-06 | P1 |
| RUN-09 | Sandbox: Linux bubblewrap + macOS seatbelt engagement | RUN-06 | P1 |
| RUN-10 | Repo-map retrieval into context planner | RUN-05 | P2 |
| RUN-11 | codemode v2 operator mode (confined REPL + DAG spawn) | RUN-01, RUN-03 | P2 |
| RUN-12 | Stage 7 completion: projections UI, artifact browsing, i18n/arm64 blockers | RUN-01, RUN-05 | P2 |
| RUN-13 | V2 parity completion + legacy session decommission | RUN-02..05, RUN-08 | P0-gated |
| RUN-14 | Daemon workers: attach/detach, /goal, heartbeat/schedule, autonomy gates | RUN-01, RUN-13 | P2 |
| RUN-15 | Persistent model-owned terminals + terminal surfaces | RUN-13 | P2 |

Deferred-by-decision (do NOT plan or build, per audit §21): computer-use /
browser automation / Record-and-Replay; Tauri desktop cutover; multi-agent
planning-debate PoC; Codex-plugin compatibility shim; embeddings/vector store
(repo-map first, RUN-10); Windows sandbox Stage 6 follow-ups remain in
`../TODO.md` and are reserved for dedicated systems capacity, not these runs.

## 2. Global Constraints (apply to EVERY task of EVERY run)

Copy these verbatim into every subagent prompt that writes code:

1. **Branching:** default product branch is `main`. Branch names: ≤3
   hyphenated words, no slashes, no type prefixes (e.g. `sidecar-supervision`).
2. **Commits:** conventional style `type(scope): summary`; types: `feat`,
   `fix`, `docs`, `chore`, `refactor`, `test`; scope = affected package or area
   (`core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, `plugin`,
   `ultracode-*`). Stage only files changed for the task; never `git add -A`.
3. **Tests:** never run from repo root. Run from the owning package
   directory (e.g. `cd packages/opencode && bun test test/<file>.ts`). Type
   checking: `bun typecheck` from the owning package directory, never `tsc`
   directly.
4. **One owner per subsystem (ULTRACODE.md §4):** one prompt compiler
   (`packages/ultracode-context`), one context planner/compaction controller,
   one journal (`crates/ultracode-events` sidecar), one tool registry, one
   artifact/truncation pass, one approval verdict per side effect, one provider
   adapter per route, one agent-spawn primitive, one world-state engine. Any
   change introducing a second owner is a defect; stop and escalate.
5. **Provenance (ULTRACODE.md §5):** no code from `../codex` or
   `../claude-code-sourcemap` may enter this repo without an entry in
   `docs/provenance/ledger.json` validated by
   `bun run scripts/provenance/validate.ts`. Ideas are reimplemented; text is
   never copied. Claude-derived work additionally requires an authorization
   file under `docs/provenance/authorizations/`.
6. **Repo style (root AGENTS.md):** no `try`/`catch` where avoidable; no
   `any`; no import aliases; no star imports; prefer dynamic imports in
   startup-sensitive entrypoints; `const` over `let`; no `else` (early
   returns); dot notation over destructuring; functional array methods; Bun
   APIs (`Bun.file`) over node fs where possible; Effect generators bind
   services to named variables before use; inline single-use helpers.
7. **API changes:** after changing the public Protocol or Server `HttpApi`,
   run `bun run generate` from `packages/client`; never edit
   `packages/client/src/generated*` by hand. Runtime dependencies flow
   Schema → {Core, Protocol} → Server; Client depends only on Schema/Protocol.
8. **V2 session invariants (root AGENTS.md "V2 Session Core"):** one
   `llm.stream(request)` per provider turn; durable admission before advisory
   wake; steer promotes at safe boundaries, queue promotes one-at-a-time at
   idle; interruption targets the process-local ownership chain; never bridge
   V2 through legacy `SessionPrompt.loop`.
9. **Testing discipline:** no mocks unless no alternative; never touch
   `globalThis` except as last resort; test real implementations; do not copy
   implementation logic into tests.
10. **V1 freeze (in effect from RUN-01 onward):** `packages/opencode/src/session/prompt.ts`,
    `processor.ts`, `session.ts` receive bugfixes only. New behavior lands in
    `packages/core` (V2) or `@ultracode/*` packages. If a task seems to require
    a V1 feature, escalate instead of adding it.

## 3. Exploration Protocol (before dispatching ANY subagent)

Subagents have zero context. You give them context; to do that accurately you
must first explore yourself.

1. Read the run file in full.
2. Read every file listed in the run's "Context Files" section **in full**
   (not snippets). These paths were accurate on 2026-08-06; verify each still
   exists with `test -f <path>`. If a file moved, find the successor with
   `rg` and update the plan's excerpts to match reality — code wins, plan
   loses. Record deviations in the run ledger (§8).
3. Run the run's "Baselines" commands and record output (test suite health,
   typecheck, sidecar presence).
4. Check sibling-run interfaces: if the run consumes outputs of an earlier
   run (see its `Interfaces: Consumes` blocks), open those run files and copy
   the exact produced signatures into your subagent prompts.

## 4. Subagent Dispatch Protocol

Use subagent-driven development: **one fresh subagent per task**, in order.
Never batch two tasks into one subagent. Never let a subagent start a task
whose `Interfaces: Consumes` dependencies are unmerged.

Each subagent prompt MUST contain, in this order:

```
You are implementing Task N of <RUN-XX> in /home/thymia/UltraCode-Planning/opencode.
RULES (verbatim):
1. Bite-sized TDD: write the failing test first, run it, watch it fail,
   implement the minimal code, run it, watch it pass, then commit.
2. Test commands (never from repo root; from the owning package dir):
   bun test <test-file>          # run one file
   bun typecheck                 # typecheck the package
3. Commit per task: `type(scope): summary`. Stage only the files you changed
   (list them); never `git add -A`, never `git add .`; no --no-verify.
4. Style: <paste Global Constraints items 6 verbatim>
5. No placeholders. If the plan's code excerpt does not match the real code,
   the real code wins; note the deviation in your final message.
6. When you're done, reply with ONLY: files changed, test command outputs
   (tail), commit hash, and any deviations. No summary essays.
CONTEXT:
- Read these files in full before writing anything: <list from the task's
  Files block + plan's Context Files the task touches>
TASK: <paste the entire Task N block verbatim>
```

Two-stage gate after each subagent returns:

- **Stage A — mechanical:** verify yourself: the commit exists
  (`git log --oneline -1`), the test command passes when YOU run it, typecheck
  passes when YOU run it, `git show --stat` touches only declared files.
  Evidence before belief, always.
- **Stage B — review:** dispatch a fresh review subagent with the Review
  Prompt (§5). Address findings before starting the next task.

## 5. Review Prompts

### 5.1 Task-level review prompt (dispatch per task)

```
Review the most recent commit (<hash>) in /home/thymia/UltraCode-Planning/opencode
against this task spec: <paste Task N block verbatim>.
Check, in order:
1. Correctness: does the implementation do what the task's steps require,
   nothing more (YAGNI)?
2. Tests: do the tests assert real behavior (no tautologies, no mocks of the
   unit under test, no copied implementation logic)?
3. Repo invariants: Global Constraints (list below) violations — name file:line.
4. Types: do exported names/signatures match the task's Interfaces: Produces
   block EXACTLY (names, parameter and return types)?
5. Minimalism: does the diff touch only the task's declared Files?
Reply as a numbered list of findings, each tagged BLOCKER or MINOR, with
file:line. If there are no findings, reply exactly: "NO FINDINGS".
Do not edit any files.
```

### 5.2 Run-level review prompt (dispatch after last task; also in each run file)

Each run file ends with its own run-level review prompt containing
run-specific checks. Use it verbatim, appending the list of commit hashes
produced during the run.

## 6. Anti-Hallucination Completion Rules

A run is DONE only when ALL of the following are true, verified by you with
commands, not by subagent reports:

1. Every task's Stage A gate passed (fresh verification by you).
2. The run-level review subagent's verdict contains no open BLOCKER findings.
3. Every item in the run's "Definition of Done" checklist is checked by a
   command you ran and output you saw.
4. `git status` is clean; every change is committed; branch matches §2.1
   naming.
5. `bun typecheck` passes in every package the run touched.
6. The run ledger (§8) entry is written with commit range and deviations.

If any of these are false, the run is NOT DONE. Never report a run as
complete based on subagent summaries.

## 7. Cross-Run Interface Registry

When a run changes a public interface used by later runs, record it here
before marking the run DONE (subagents of later runs read only their own run
file + this registry):

| Producer run | Symbol / endpoint / table | Location | Consumer runs |
|---|---|---|---|
| RUN-01 | `SidecarSupervisor` service + `EventsClient.start(opts)` opts shape | `packages/ultracode-events-client/src/index.ts`, `packages/opencode/src/agent/scheduler-service.ts` | RUN-02, 07, 11, 12, 14 |
| RUN-01 | `Scheduler.waitForTasks({taskIds, timeoutMs})` | `packages/ultracode-agents/src/scheduler.ts` | RUN-11, 14 |
| RUN-02 | `core/memory` System Context source key + `MemoryReview` routes | `packages/core/src/memory/*` | RUN-13 |
| RUN-03 | `Tools.Service.register` plugin/MCP path + runner `materialize(permissions, query)` | `packages/core/src/tool/registry.ts` | RUN-11, RUN-13 |
| RUN-04 | `CompactionCheckpoint` artifact writes + `cache-edit` policy flag | `packages/core/src/session/compaction.ts` | RUN-13 |
| RUN-05 | `CapabilityProfile` resolution in runner + diagnostics routes | `packages/core/src/session/runner/model.ts` | RUN-10, RUN-12, RUN-13 |
| RUN-06 | `ApprovalPipeline` (one entry point) + decision system + role model config | `packages/core/src/permission/*` | RUN-08, RUN-09, RUN-13, RUN-14 |
| RUN-07 | `ExperimentCheckpoint` + rewind surface | `packages/opencode/src/snapshot/*` | RUN-13, RUN-14 |
| RUN-10 | `RepositoryMap` evidence block | `packages/ultracode-context/src/planner/*` | RUN-13 |
| RUN-13 | V2-only session engine (legacy loop deleted) | `packages/core`, `packages/opencode` | RUN-14, RUN-15 |

## 8. Run Ledger

Append one row when a run is marked DONE (and only then):

| Run | Date | Commit range | Baselines green? | Deviations |
|---|---|---|---|---|
| _none yet_ | | | | |

## 9. What To Do When Reality Disagrees With A Plan

Plans contain code excerpts accurate as of 2026-08-06. Drift happens. Rules:
- Signatures, file paths, table names: code wins — update the excerpt, record
  the deviation, keep intent.
- Intent (invariants, owners, one-journal rule): never bend. If code reality
  makes intent impossible, STOP the run and record the blocker in the ledger.
- Never "discover" a shortcut that skips the test-first cycle. The cycle is
  the plan.
