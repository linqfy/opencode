# Performance Baselines

Record-only, machine-agnostic baseline numbers for the opencode V2 runtime. These are
deliberately host-specific samples — the harness records them, it never enforces them.

## Metrics

| Metric | What it measures |
|---|---|
| `startup_ms` | Cold process → interactive: `bun --cwd packages/opencode --conditions=browser src/index.ts serve` until the "opencode server listening on http://" marker. |
| `session_open_ttft_ms` | Time from admitting a prompt to the first `Text.Delta` on a recorded cassette (`session-runner/openai-chat-streams-text`), driven through the real in-process runner. |
| `idle_memory_after_sessions_mb` | Process RSS (MB) sampled after session work settles, in the same process that ran the TTFT measurements. |
| `sidecar_spawn_ms` | `EventsClient.start` → first `ping` round-trip (the sidecar binary spawn + handshake window). |

## Running

```bash
cargo build -p ultracode-events   # prerequisite: produces the sidecar binary
bun run perf/baseline.ts          # from repo root
```

The harness honors `BASELINE_RUNS` (default 3) for sample count. The sidecar binary is
looked up via `ULTRACODE_EVENTS_SIDECAR_BIN`, then `packages/opencode/target/debug/sidecar`,
then `target/debug/sidecar`; the script exits with a build hint if none is present.

## Output

`perf/baselines.json` is committed with the four metrics as numeric `{ runs, p50, p95 }`
plus `captured_at` (ISO timestamp) and `reference_machine` pointing at
`docs/benchmarks/environment.json` as the host-record target.

## Policy

Record-only. Per `packages/app/e2e/performance/AGENTS.md` items 11–12:

- Do not enforce machine-dependent performance thresholds.
- Assert scenario completion and metric collection only.

The committed `baselines.json` is a point-in-time host record; refresh it by re-running
the harness on the target machine rather than comparing across machines.
