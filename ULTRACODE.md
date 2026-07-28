# UltraCode

UltraCode is a provider-neutral coding harness built as a downstream product of OpenCode, combining selected subsystems from OpenCode, Claude Code, and Codex under one protocol and one owner per subsystem. The governing architecture is `docs/architecture/2026-07-28-harness-architecture.md` (workspace original: `../docs/superpowers/specs/2026-07-28-ultracode-harness-architecture-design.md`, revision `2026-07-28b`).

## Repository rules

1. Upstream `AGENTS.md` remains authoritative for code style, commit format, and testing. This file overrides only repository-level product rules.
2. The mainline branch is `main`. The `dev` branch tracks `upstream/dev` and exists only for upstream merges; never commit product work to `dev`.
3. Feature branches use at most three hyphenated words, no slashes, no type prefixes (upstream convention).
4. Exactly one owner per harness subsystem: one prompt compiler; one context planner and compaction controller; one canonical transcript and append-only event journal; one tool registry and deferred discovery index; one artifact/truncation pass; one approval verdict per proposed side effect; one provider adapter responsible for wire lowering per route; one public agent-spawn primitive and scheduler; one world-state baseline/diff engine. Reject any change that introduces a second one.
5. No code from `../claude-code` or `../codex` enters this repository without a `docs/provenance/ledger.json` entry that passes `bun run scripts/provenance/validate.ts`. Imports from the Claude Code source additionally require a written authorization file under `docs/provenance/authorizations/`.
6. `packages/app` and `packages/ui` are the downstream product UI; keep edits minimal and upstream-mergeable.
