# Provenance

`sources.json` registers every external source tree with its pinned commit and license basis. `ledger.json` records every imported, ported, or reimplemented module. `scripts/provenance/validate.ts` is the machine check; run it before any commit that adds an import:

    bun run scripts/provenance/validate.ts

Rules:

1. Every `copy` or `port` ledger entry cites the source's pinned commit (or a deliberately recorded newer one).
2. The Claude Code source has no license file. Any ledger entry with `source_id: "claude-code"` must set `authorization_ref` to a written authorization stored under `docs/provenance/authorizations/` covering copying, modification, redistribution, sublicensing, and commercial distribution. The validator fails otherwise.
3. Codex is Apache-2.0: its `NOTICE` obligations are tracked per entry via `notice_required`.
4. Every entry names an `owner` (responsible for the code) and an `upstream_merge_owner` (responsible for future upstream merges of that file).
