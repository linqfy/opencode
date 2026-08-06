# RUN-09: Sandbox Engagement — Linux bubblewrap + macOS seatbelt through the broker

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `ultracode-sandbox-broker` crate with Linux bubblewrap and macOS seatbelt backends, then engage containment at the `bash` and PTY call sites using the agent's sandbox profile instead of the hardcoded unconfined profile — with `agent.sandbox: "required"` honored end-to-end, and containment failing closed everywhere.

**Architecture:** One JSON-lines stdio protocol, three platforms. The existing broker crate (`crates/ultracode-sandbox-broker`) keeps its `probe`/`launch`/`terminate` protocol and gains `#[cfg(target_os = "linux")]` (bubblewrap) and `#[cfg(target_os = "darwin")]` (seatbelt) backends behind a shared `unix` module. The TS `@ultracode/sandbox` broker planner gains a platform-neutral `containment` field on `Profile`, unix capability vocabulary, and a pure degradation policy (`required` + capability unavailable → deny; `requested` → allow unconfined with a journaled warning). Core `SandboxProcess.Service` resolves the agent's sandbox profile; `bash` and `pty` plan with it. Default stays unconfined; flipping the default is a RUN-13-era migration decision.

**Tech Stack:** Rust (cargo, `libc` on unix, no other new deps), TypeScript, Effect-TS, `bwrap` (Linux), `/usr/bin/sandbox-exec` (macOS), Bun.

**Audit basis:** §5.3 (sandbox is nominal), §13 (Codex orchestrator: approval → sandbox → attempt), §15 (Codex per-OS sandbox implementation detail — design understanding only, reimplement from invariants), §18 A5, §23 P1 item 7 ("macOS seatbelt + Linux bwrap containment engaged by default through the existing broker plan"), §22 Stage 6 Windows block (keep fail-closed), `docs/provenance/codex-windows-sandbox-2026-08-02.md` (the provenance template this run must mirror for Linux+macOS).

## Global Constraints

All constraints in `TODO/README.md` §2 apply verbatim. In addition:

- **Fail-closed everywhere.** A containment request that cannot be enforced is never silently downgraded: `required` → deny launch; `requested` → allow unconfined **only** with an explicit journaled warning. WSL stays fail-closed (`probe` returns `unsupported`).
- **One protocol, three platforms.** The broker wire protocol stays a single JSON-lines protocol; all backend changes are additive and backwards-compatible with the existing Windows protocol conventions (optional new request/response fields, existing fields never re-interpreted).
- **Provenance is mandatory.** Task 8 MUST produce `docs/provenance/codex-unix-sandbox-<date>.md` + `docs/provenance/ledger.json` (and the `sources.json` the validator requires) and MUST pass `bun run scripts/provenance/validate.ts` from repo root. No text is copied from `../codex`; only safety invariants are reimplemented. See Task 8's invariant list.
- **Rust rules.** Rust tests and clippy run from repo root (Rust is exempt from the package-dir test rule): `cargo test -p ultracode-sandbox-broker` and `cargo clippy -p ultracode-sandbox-broker -- -D warnings`. The crate must not gain non-`libc` runtime dependencies on unix. `cargo` must be available to run tasks (see Baselines).
- **Branch:** `sandbox-unix`.
- **Integration tests SKIP, never fail, when the platform backend is absent.** Linux bwrap and macOS seatbelt integration tests must detect backend availability at runtime and early-return (skip) when unavailable, so CI runners without `bwrap`/`sandbox-exec` stay green.

## Orchestrator Brief

### Context Files (read in full before dispatching Task 1)

1. `packages/ultracode-sandbox/src/sandbox.ts` — the pure TS `Broker` planner: `Profile`, `LaunchRequest`, `LaunchPlan`, `DeniedPlan`, `Broker.plan`. The file this run's degradation policy extends.
2. `packages/ultracode-sandbox/src/native.ts` — `BROKER_PROTOCOL_VERSION = 1`, `BrokerCapability`, `BrokerRequest`/`BrokerResponse`, `parseBrokerResponse`, `NativeSupervisor` (`ensureForProfile`).
3. `packages/ultracode-sandbox/test/broker.test.ts` and `packages/ultracode-sandbox/test/native.test.ts` — existing behavior pins; some linux expectations change under the new unix containment semantics (enumerated in Task 5).
4. `crates/ultracode-sandbox-broker/src/lib.rs` — the broker crate: `Request`/`Response` structs, `validate_request`, `dispatch`, `#[cfg(windows)] mod windows`. The protocol's Windows conventions live here.
5. `crates/ultracode-sandbox-broker/src/bin/broker.rs` — the stdio loop.
6. `crates/ultracode-sandbox-broker/tests/windows_containment.rs` — the integration-test style: real launch, terminate-tree, fail-closed boundary assertions.
7. `crates/ultracode-sandbox-broker/Cargo.toml` — dependency closure (`serde`, `serde_json`, `windows-sys` on win32 only).
8. `packages/core/src/sandbox.ts` — `SandboxProcess` service: hardcoded `unconfinedProfile`, win32-only supervisor, `prepare`.
9. `packages/core/src/tool/bash.ts` — the plan call site at lines ~160–167; shell resolution at ~156–159.
10. `packages/core/src/pty.ts` — the plan call site at lines ~187–195.
11. `packages/core/src/permission.ts` — `sandboxProfile` shape: `configuredRuleset.profile?.sandboxProfile` carried into `Decision.sandboxProfile` (line ~217); `Agent.Info.permissionProfile`.
12. `packages/schema/src/permission.ts` — `Profile.sandboxProfile: Schema.String.pipe(optional)`; `packages/schema/src/agent.ts` — `Agent.Info` (gains `sandbox` in Task 6).
13. `packages/core/src/config/agent.ts` and `packages/core/src/config/plugin/agent.ts` — config agent shape + the mapping into `Agent.Info`.
14. `packages/opencode/script/build.ts` — packaging pattern (stages `dist/<target>/bin/opencode`); Task 7 stages the broker beside it.
15. `.github/workflows/test.yml` — CI runs `bun turbo test` on linux+windows; **no Rust step exists** (Rust tests run locally per this run's protocol; TS integration tests must skip without `bwrap`/`sandbox-exec`).
16. `docs/provenance/codex-windows-sandbox-2026-08-02.md` — the provenance template: Authorization, Dependency Closure Audit, Ported Invariants, Explicit Limits. Task 8 mirrors this style.
17. `scripts/provenance/validate.ts` — the validator: requires `docs/provenance/sources.json` and `docs/provenance/ledger.json` (NEITHER EXISTS YET — Task 8 creates both).
18. Design references (READ ONLY, do not copy text): `../codex/codex-rs/sandboxing/src/{bwrap.rs,seatbelt.rs,seatbelt_base_policy.sbpl}`, `../codex/codex-rs/linux-sandbox/src/bwrap.rs`. Extracts for invariant understanding only: bubblewrap "read-only root by default (`--ro-bind / /`), writable roots layered with `--bind`", network deny via `--unshare-net`, env allowlist via `--clearenv`+`--setenv`, fixed `/usr/bin/sandbox-exec` path, seatbelt closed-by-default `(deny default)` with `file-write*` subpath allows and `(deny network*)`.

### Baselines (record before Task 1)

```bash
cd packages/ultracode-sandbox && bun test 2>&1 | tail -5
cd packages/ultracode-sandbox && bun typecheck 2>&1 | tail -3
cd packages/core && bun test test/tool-bash.test.ts test/pty/pty-session.test.ts 2>&1 | tail -5
cargo test -p ultracode-sandbox-broker 2>&1 | tail -5
which bwrap; which sandbox-exec; echo "WSL_DISTRO_NAME=$WSL_DISTRO_NAME WSL_INTEROP=$WSL_INTEROP"
```

Notes: `bwrap` is present at `/usr/bin/bwrap` on the reference Linux host; `sandbox-exec` does not exist on Linux (macOS tests skip). `cargo` may not be on PATH in the shell — if `cargo --version` fails, install the Rust toolchain first (e.g. `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`, then `source "$HOME/.cargo/env"`) before Task 2. Record the baseline outputs in the run ledger.

### Dispatch Order

Tasks 1 → 9 strictly sequential. Task 3 depends on Task 2 (protocol fields); Task 5 depends on Tasks 2–4 (capability vocabulary + backends) and Task 1 (characterization); Task 6 depends on Task 5; Task 7 on Task 5's `resolveBrokerBin`; Task 8 on all Rust+TS code landing; Task 9 last.

### Definition of Done (verify each with a command you ran)

- [ ] Broker `probe` on Linux answers `{"outcome":"ready","capabilities":[…bwrap…]}`: `printf '%s\n' '{"version":1,"request_id":"r1","method":"probe"}' | target/release/ultracode-sandbox-broker` (build via `cargo build --release -p ultracode-sandbox-broker` first).
- [ ] A fail-closed network test passes by name: `cargo test -p ultracode-sandbox-broker --test linux_bwrap network_denied_child_cannot_reach_fixture_listener` (on Linux with bwrap present; it skips otherwise).
- [ ] `cargo test -p ultracode-sandbox-broker` green and `cargo clippy -p ultracode-sandbox-broker -- -D warnings` clean.
- [ ] `bun test` green in `packages/ultracode-sandbox` and `packages/core`; `bun typecheck` green in `packages/{ultracode-sandbox,core}` (and `packages/opencode` if Task 7 touched it).
- [ ] `agent.sandbox: "required"` config end-to-end: a bash tool call with a `sandbox: "required"` agent and no usable backend is **denied** (fails closed), and with a usable Linux backend launches contained (probe returned `bwrap` capabilities).
- [ ] dist artifact exists: `ls dist/<host-triple>/bin/ultracode-sandbox-broker` after running `bun run script/build.ts --single`.
- [ ] `bun run scripts/provenance/validate.ts` exits 0 from repo root.
- [ ] `git status` clean; branch `sandbox-unix`; run ledger row written in `TODO/README.md` §8 with commit range and deviations.

---

### Task 1: Characterize Broker plan + protocol (behavior pins)

**Files:**
- Modify: `packages/ultracode-sandbox/test/broker.test.ts`
- Modify: `packages/ultracode-sandbox/test/native.test.ts`

**Interfaces:**
- Consumes: current `Sandbox.Broker.create`/`plan`, `parseBrokerResponse`, `NativeSupervisor` (Context Files 1–3).
- Produces: a set of passing behavior pins that Tasks 2/3/5 rely on for backwards compatibility. Task 5 will intentionally change two of these pins; until then they document current behavior.

- [ ] **Step 1: Write the failing tests** — append to `packages/ultracode-sandbox/test/broker.test.ts`:

```ts
test("characterization: contained profile on linux with no backend and no containment option is denied", () => {
  const broker = Sandbox.Broker.create({ platform: "linux" })
  expect(broker.plan(request({ profile: contained() }))).toMatchObject({
    outcome: "deny",
    reason: "containment-unsupported",
  })
})

test("characterization: policy veto applies to unconfined launches", () => {
  const broker = Sandbox.Broker.create({
    platform: "linux",
    policy: () => ({ outcome: "deny", reason: "network-policy" }),
  })
  expect(broker.plan(request())).toMatchObject({ outcome: "deny", reason: "network-policy" })
})

test("characterization: capabilities alone do not allow a contained launch without a containment backend", () => {
  const broker = Sandbox.Broker.create({
    platform: "linux",
    capabilities: ["explicit-environment", "writable-root", "network-deny"],
  })
  expect(broker.plan(request({ profile: contained() }))).toMatchObject({
    outcome: "deny",
    reason: "containment-unsupported",
  })
})

test("characterization: probe responses never carry launch fields and vice versa", () => {
  expect(() =>
    parseBrokerResponse(
      JSON.stringify({ version: 1, request_id: "x", method: "probe", outcome: "ready", capabilities: [], pid: 1 }),
    ),
  ).not.toThrow()
  expect(parseBrokerResponse(JSON.stringify({ version: 1, request_id: "x", method: "launch", outcome: "denied" }))).toMatchObject({
    outcome: "denied",
  })
})
```

And append to `packages/ultracode-sandbox/test/native.test.ts`:

```ts
test("characterization: ensureForProfile always requires Windows-specific capabilities regardless of platform", async () => {
  const supervisor = NativeSupervisor.create({
    path: "unused",
    broker: () => ({
      request: async (request) =>
        ({ version: 1, request_id: request.request_id, method: "probe", outcome: "ready" as const, capabilities: ["explicit-environment", "writable-root"] }),
      close: () => undefined,
    }),
  })
  await expect(supervisor.ensureForProfile({ writableRoots: ["/w"], readRoots: ["/"], allowedExecutables: ["*"], environment: ["*"], network: "deny", windowsContainment: "required" })).resolves.toEqual([])
  supervisor.close()
})
```

Note the third test deliberately asserts today's strict behavior (capabilities present but no `containment` option → still denied); it remains a valid regression pin under the Task 5 policy (the `if (!backend)` final check still denies). The `ensureForProfile` test asserts today's win32-centric requirements and IS replaced by Task 5's unix semantics.

- [ ] **Step 2: Run, watch them pass**

Run: `cd packages/ultracode-sandbox && bun test test/broker.test.ts test/native.test.ts`
Expected: all pass (they pin current behavior; if any fails, the file drifted — fix the test to match current code and record the deviation).

- [ ] **Step 3: Typecheck**

Run: `cd packages/ultracode-sandbox && bun typecheck`

- [ ] **Step 4: Commit**

```bash
git add packages/ultracode-sandbox/test/broker.test.ts packages/ultracode-sandbox/test/native.test.ts
git commit -m "test(ultracode-sandbox): pin broker plan and protocol behavior"
```

---

### Task 2: Broker protocol/capability extension (Rust, additive)

**Files:**
- Modify: `crates/ultracode-sandbox-broker/src/lib.rs` (fields, validation, capability constants)
- Create: `crates/ultracode-sandbox-broker/tests/protocol.rs`

**Interfaces:**
- Consumes: `Request`/`Response`/`validate_request`/`PROTOCOL_VERSION` (Context File 4).
- Produces (canonical protocol additions, all optional — a v1 peer that omits them keeps working; the Windows backend ignores them):
  - `Request.containment: Option<String>` — `"required" | "requested"`; absent means `"required"` (fail-closed default).
  - `Response.containment: Option<String>` — `"contained" | "unconfined"` (applied containment on `launch`).
  - `Response.warning: Option<String>` — human-readable journalable warning on `launch` when degraded to unconfined.
  - Capability vocabulary constants (shared `&str` values, exported for tests): `bwrap`, `bwrap-netns`, `seatbelt-profile`, `explicit-environment`, `writable-root`, `network-deny`, `job-object-atomic`, `restricted-token`.

- [ ] **Step 1: Write the failing tests** — create `crates/ultracode-sandbox-broker/tests/protocol.rs`:

```rust
use ultracode_sandbox_broker::{validate_request, Request};

#[test]
fn accepts_containment_values_on_launch() {
    let required = Request {
        version: 1,
        request_id: "r1".into(),
        method: "launch".into(),
        executable: Some("/bin/sh".into()),
        args: Some(vec!["-c".into(), "true".into()]),
        cwd: Some("/workspace".into()),
        roots: Some(ultracode_sandbox_broker::Roots { read: vec!["/".into()], writable: vec!["/workspace".into()] }),
        environment: Some(Default::default()),
        network: Some("allow".into()),
        job_id: None,
        containment: Some("required".into()),
    };
    assert_eq!(validate_request(&required), Ok(()));

    let mut requested = required.clone();
    requested.containment = Some("requested".into());
    assert_eq!(validate_request(&requested), Ok(()));
}

#[test]
fn rejects_unknown_containment_values() {
    let mut request = Request {
        version: 1,
        request_id: "r1".into(),
        method: "launch".into(),
        executable: Some("/bin/sh".into()),
        args: Some(vec![]),
        cwd: Some("/workspace".into()),
        roots: Some(ultracode_sandbox_broker::Roots { read: vec!["/".into()], writable: vec!["/workspace".into()] }),
        environment: Some(Default::default()),
        network: Some("allow".into()),
        job_id: None,
        containment: Some("sometimes".into()),
    };
    assert!(validate_request(&request).is_err());
}

#[test]
fn absent_containment_defaults_to_required_on_launch() {
    let request = Request {
        version: 1,
        request_id: "r1".into(),
        method: "launch".into(),
        executable: Some("/bin/sh".into()),
        args: Some(vec![]),
        cwd: Some("/workspace".into()),
        roots: Some(ultracode_sandbox_broker::Roots { read: vec!["/".into()], writable: vec!["/workspace".into()] }),
        environment: Some(Default::default()),
        network: Some("allow".into()),
        job_id: None,
        containment: None,
    };
    assert_eq!(validate_request(&request), Ok(()));
}
```

- [ ] **Step 2: Run, watch fail**

Run: `cargo test -p ultracode-sandbox-broker --test protocol`
Expected: FAIL — `Request` has no `containment` field.

- [ ] **Step 3: Implement** — in `crates/ultracode-sandbox-broker/src/lib.rs`:
  - Add `pub containment: Option<String>` to `Request` (after `network`, before `job_id`).
  - Add `pub containment: Option<String>` and `pub warning: Option<String>` to `Response` (after `pid`).
  - In `validate_request`'s `launch` arm, accept `Some("required") | Some("requested")`, reject other `Some` values (mirror the existing `network` validation style).
  - Export capability constants near `PROTOCOL_VERSION`:
    ```rust
    pub const CAP_BWRAP: &str = "bwrap";
    pub const CAP_BWRAP_NETNS: &str = "bwrap-netns";
    pub const CAP_SEATBELT_PROFILE: &str = "seatbelt-profile";
    pub const CAP_EXPLICIT_ENVIRONMENT: &str = "explicit-environment";
    pub const CAP_WRITABLE_ROOT: &str = "writable-root";
    pub const CAP_NETWORK_DENY: &str = "network-deny";
    pub const CAP_JOB_OBJECT_ATOMIC: &str = "job-object-atomic";
    pub const CAP_RESTRICTED_TOKEN: &str = "restricted-token";
    ```
  - Use the constants in the existing `windows::probe` capability list (replace string literals) so the vocabulary is single-sourced. Do not change any `#[cfg(windows)]` behavior.

- [ ] **Step 4: Run, watch pass** — same command as Step 2; then full `cargo test -p ultracode-sandbox-broker`.

- [ ] **Step 5: Clippy** — `cargo clippy -p ultracode-sandbox-broker -- -D warnings`

- [ ] **Step 6: Commit**

```bash
git add crates/ultracode-sandbox-broker/src/lib.rs crates/ultracode-sandbox-broker/tests/protocol.rs
git commit -m "feat(ultracode-sandbox-broker): additive containment and warning protocol fields"
```

---

### Task 3: Linux bubblewrap backend (Rust)

**Files:**
- Modify: `crates/ultracode-sandbox-broker/Cargo.toml`
- Create: `crates/ultracode-sandbox-broker/src/unix.rs`
- Create: `crates/ultracode-sandbox-broker/src/unix/linux.rs`
- Modify: `crates/ultracode-sandbox-broker/src/lib.rs` (route `#[cfg(target_os = "linux")]` probe/launch/terminate into `unix::linux`)
- Create: `crates/ultracode-sandbox-broker/tests/linux_bwrap.rs`

**Interfaces:**
- Consumes: `Request`/`Response`/`Roots`/capability constants (Task 2).
- Produces:
  - `unix::find_in_path_from(path: &str, program: &str) -> Option<PathBuf>` and `unix::find_in_path(program: &str) -> Option<PathBuf>` — searches `PATH`, **skipping empty segments** (the empty segment means the current working directory — never search the CWD for `bwrap`, mirroring the Codex invariant).
  - `unix::spawn_in_new_pgid(program: &str, args: &[String], cwd: &str, environment: &BTreeMap<String, String>) -> io::Result<(u32, i32)>` — spawns with `std::os::unix::process::CommandExt::process_group(0)`; returns `(pid, pgid)`, pgid == pid.
  - `unix::kill_pgid(pgid: i32, signal: libc::c_int)` — `libc::kill(-pgid, signal)`.
  - `unix::is_wsl() -> bool` — `WSL_DISTRO_NAME` or `WSL_INTEROP` set.
  - `linux::probe(request_id: String) -> Response` — resolves `bwrap`, runs a real namespace probe, returns `ready` with `["explicit-environment", "writable-root", "network-deny", "bwrap", "bwrap-netns"]` or `unsupported` with reason; WSL → `unsupported`.
  - `linux::bwrap_argv(executable, args, cwd, environment, roots, network) -> Vec<String>` — pure builder.
  - `linux::launch(request) -> Response`, `linux::terminate(request) -> Response`.
  - Linux `probe`/`launch`/`terminate` wired into `lib.rs` behind `#[cfg(target_os = "linux")]`.

- [ ] **Step 1: Add the `libc` dependency** — in `crates/ultracode-sandbox-broker/Cargo.toml`:

```toml
[target.'cfg(unix)'.dependencies]
libc = "0.2"
```

Run `cargo build -p ultracode-sandbox-broker` to confirm resolution (Cargo.lock updates; commit the lockfile with the task).

- [ ] **Step 2: Write the failing unit tests** — inline in `crates/ultracode-sandbox-broker/src/unix/linux.rs` under `#[cfg(test)]`:

```rust
#[test]
fn bwrap_argv_orders_namespace_mounts_env_and_command() {
    let mut environment = BTreeMap::new();
    environment.insert("PATH".to_string(), "/bin".to_string());
    environment.insert("HOME".to_string(), "/home/u".to_string());
    let argv = bwrap_argv(
        "/bin/sh",
        &["-c".to_string(), "true".to_string()],
        "/workspace",
        &environment,
        &Roots { read: vec!["/".to_string()], writable: vec!["/workspace".to_string()] },
        "deny",
    );
    assert!(argv.iter().any(|a| a == "--unshare-net"));
    assert!(argv.iter().any(|a| a == "--clearenv"));
    assert_eq!(argv.windows(3).filter(|w| w[0] == "--setenv" && w[1] == "PATH").count(), 1);
    assert_eq!(argv.windows(3).filter(|w| w[0] == "--bind" && w[1] == "/workspace").count(), 1);
    assert!(argv.windows(3).any(|w| w[0] == "--ro-bind" && w[1] == "/" && w[2] == "/"));
    assert!(argv.iter().position(|a| a == "--").map(|i| &argv[i + 1]).is_some_and(|c| c == "/bin/sh"));
}

#[test]
fn bwrap_argv_omits_netns_when_network_is_allowed() {
    let argv = bwrap_argv("/bin/true", &[], "/", &BTreeMap::new(),
        &Roots { read: vec!["/".into()], writable: vec![] }, "allow");
    assert!(!argv.iter().any(|a| a == "--unshare-net"));
}

#[test]
fn find_in_path_skips_empty_segments() {
    let found = find_in_path_from(&format!(":/usr/bin:{}", std::env::temp_dir().display()), "ls");
    assert!(found.is_none() || found.unwrap().starts_with("/usr/bin"));
}
```

- [ ] **Step 3: Run, watch fail** — `cargo test -p ultracode-sandbox-broker` → module `unix` not found.

- [ ] **Step 4: Implement**
  - `src/unix.rs` (cfg `unix`): `find_in_path_from(path: &str, program: &str) -> Option<PathBuf>` (pure: split on `:`, skip empty segments, prefer an absolute candidate that exists and is executable), `find_in_path(program: &str) -> Option<PathBuf>` (reads `PATH`, delegates), `spawn_in_new_pgid` (build `Command`, `std::os::unix::process::CommandExt::process_group(0)`, `spawn`, return `(pid, pid as i32)`), `kill_pgid` (`libc::kill`), `is_wsl`.
  - `src/unix/linux.rs`: `bwrap_argv`:
    ```rust
    pub fn bwrap_argv(
        executable: &str,
        args: &[String],
        cwd: &str,
        environment: &BTreeMap<String, String>,
        roots: &Roots,
        network: &str,
    ) -> Vec<String> {
        let mut argv = vec![
            "bwrap".to_string(),
            "--new-session".to_string(),
            "--die-with-parent".to_string(),
            "--unshare-pid".to_string(),
        ];
        if network == "deny" {
            argv.push("--unshare-net".to_string());
        }
        argv.push("--ro-bind".to_string());
        argv.push("/".to_string());
        argv.push("/".to_string());
        for writable in &roots.writable {
            argv.push("--bind".to_string());
            argv.push(writable.clone());
            argv.push(writable.clone());
        }
        for read in &roots.read {
            argv.push("--ro-bind".to_string());
            argv.push(read.clone());
            argv.push(read.clone());
        }
        argv.push("--clearenv".to_string());
        for (key, value) in environment {
            argv.push("--setenv".to_string());
            argv.push(key.clone());
            argv.push(value.clone());
        }
        argv.push("--chdir".to_string());
        argv.push(cwd.to_string());
        argv.push("--".to_string());
        argv.push(executable.to_string());
        argv.extend(args.iter().cloned());
        argv
    }
    ```
  - `linux::probe`: if `unix::is_wsl()` → `unsupported("bubblewrap is unsupported on WSL")`. `let bwrap = unix::find_in_path("bwrap")`; none → `unsupported("bwrap is not installed")`. Run `Command::new(&bwrap).args(["--unshare-net", "--unshare-pid", "--ro-bind", "/", "/", "--", "/bin/true"])` with a 2s timeout (`std::process::Command` + a polling loop, or spawn then wait with `try_wait`); exit 0 → `ready` with `[CAP_EXPLICIT_ENVIRONMENT, CAP_WRITABLE_ROOT, CAP_NETWORK_DENY, CAP_BWRAP, CAP_BWRAP_NETNS]`; non-zero → `unsupported` with the first line of stderr.
  - `linux::launch`: fail-closed validations first — roots.writable entries canonicalized and must exist; if `network == "deny"` and probe already passed, proceed; spawn `bwrap_argv(...)` via `unix::spawn_in_new_pgid`; on success respond `started` with `job_id = pid.to_string()`, `containment: Some("contained")`, `pid: Some(pid)`; on `io::Error` respond `failed` with the error. If the executable is not inside the read-only mount set this still launches (reads are enforced by the mount); **re-verify** that `cwd` is inside a writable root before spawning (defense in depth, same `is_contained_path` logic as the windows module).
  - `linux::terminate`: parse `job_id` as pid, `unix::kill_pgid(pid, SIGTERM)`, wait ~200ms, then `unix::kill_pgid(pid, SIGKILL)` (mirrors the Job-Object "terminate the tree" invariant); respond `terminated`. Unknown/non-numeric `job_id` → `denied`.
  - `lib.rs`: replace the `#[cfg(not(windows))]` probe/launch/terminate bodies with `#[cfg(target_os = "linux")]` routing to `unix::linux` and `#[cfg(target_os = "darwin")]` routing to `unix::macos` (macos module arrives in Task 4; to keep this task compiling on all targets, add a minimal `src/unix/macos.rs` stub in Task 3 returning `unsupported`/`denied`, fleshed out in Task 4).

- [ ] **Step 5: Write the failing integration test** — `crates/ultracode-sandbox-broker/tests/linux_bwrap.rs` (skip when bwrap absent or WSL):

```rust
#![cfg(target_os = "linux")]

use std::collections::BTreeMap;
use std::fs;
use std::net::TcpListener;
use std::process::Command;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ultracode_sandbox_broker::{dispatch, Request, Roots};

fn bwrap_available() -> bool {
    if std::env::var_os("WSL_DISTRO_NAME").is_some() || std::env::var_os("WSL_INTEROP").is_some() {
        return false;
    }
    std::env::var_os("PATH").map(|p| p.to_string_lossy().split(':').any(|seg| !seg.is_empty())).unwrap_or(false)
        && which_bwrap().is_some()
}

fn which_bwrap() -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|p| {
        p.to_string_lossy().split(':')
            .filter(|seg| !seg.is_empty())
            .map(|seg| std::path::Path::new(seg).join("bwrap"))
            .find(|candidate| candidate.is_file())
    })
}

fn workspace() -> (std::path::PathBuf, std::path::PathBuf) {
    let base = std::env::temp_dir().join(format!("ultracode-bwrap-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(base.join("w")).unwrap();
    (base, base.join("w"))
}

fn launch_child(w: &std::path::Path, argv: &[String], writable: Vec<String>, network: &str) -> String {
    let mut environment = BTreeMap::new();
    environment.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
    let response = dispatch(Request {
        version: 1,
        request_id: "launch".to_string(),
        method: "launch".to_string(),
        executable: Some(argv[0].clone()),
        args: Some(argv[1..].to_vec()),
        cwd: Some(w.display().to_string()),
        roots: Some(Roots { read: vec!["/".to_string()], writable }),
        environment: Some(environment),
        network: Some(network.to_string()),
        job_id: None,
        containment: Some("required".to_string()),
    });
    assert_eq!(response.outcome, "started", "{response:?}");
    response.job_id.unwrap()
}

#[test]
fn network_denied_child_cannot_reach_fixture_listener() {
    if !bwrap_available() { eprintln!("SKIP: bwrap unavailable"); return; }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (_base, w) = workspace();
    let marker = w.join("marker");
    let argv = vec![
        "/bin/bash".to_string(),
        "-c".to_string(),
        format!("if (exec 3<>/dev/tcp/127.0.0.1/{port}) 2>/dev/null; then echo CONNECTED > {}; else echo FAILED > {}; fi", marker.display(), marker.display()),
    ];
    let _job = launch_child(&w, &argv, vec![w.display().to_string()], "deny");
    let mut text = String::new();
    for _ in 0..100 {
        text = fs::read_to_string(&marker).unwrap_or_default();
        if !text.is_empty() { break; }
        thread::sleep(Duration::from_millis(50));
    }
    assert!(text.contains("FAILED"), "network-deny child reached the listener: {text:?}");
    let _ = fs::remove_dir_all(w.parent().unwrap());
}

#[test]
fn write_outside_writable_root_fails() {
    if !bwrap_available() { eprintln!("SKIP: bwrap unavailable"); return; }
    let (_base, w) = workspace();
    let marker = w.join("outcome");
    let argv = vec![
        "/bin/sh".to_string(),
        "-c".to_string(),
        format!("if touch /etc/pwned 2>/dev/null; then echo WROTE > {}; else echo BLOCKED > {}; fi", marker.display(), marker.display()),
    ];
    let _job = launch_child(&w, &argv, vec![w.display().to_string()], "allow");
    let mut text = String::new();
    for _ in 0..100 {
        text = fs::read_to_string(&marker).unwrap_or_default();
        if !text.is_empty() { break; }
        thread::sleep(Duration::from_millis(50));
    }
    assert!(text.contains("BLOCKED"), "wrote outside writable root: {text:?}");
    let _ = fs::remove_dir_all(w.parent().unwrap());
}

#[test]
fn environment_outside_allowlist_is_absent_in_child() {
    if !bwrap_available() { eprintln!("SKIP: bwrap unavailable"); return; }
    let (_base, w) = workspace();
    let marker = w.join("envmarker");
    // The broker runs in-process (dispatch), so this env var exists in the broker's
    // own environment. It must NOT reach the sandboxed child because the request
    // allowlist only carries PATH.
    std::env::set_var("SECRET", "DO_NOT_LEAK");
    let response = dispatch(Request {
        version: 1,
        request_id: "env".to_string(),
        method: "launch".to_string(),
        executable: Some("/bin/sh".to_string()),
        args: Some(vec![
            "-c".to_string(),
            format!("printf '%s' \"$SECRET\" > {}", marker.display()),
        ]),
        cwd: Some(w.display().to_string()),
        roots: Some(Roots { read: vec!["/".to_string()], writable: vec![w.display().to_string()] }),
        environment: Some(BTreeMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())])),
        network: Some("allow".to_string()),
        job_id: None,
        containment: Some("required".to_string()),
    });
    std::env::remove_var("SECRET");
    assert_eq!(response.outcome, "started", "{response:?}");
    let mut text = String::new();
    for _ in 0..100 {
        text = fs::read_to_string(&marker).unwrap_or_default();
        if !text.is_empty() { break; }
        thread::sleep(Duration::from_millis(50));
    }
    assert!(text.trim().is_empty(), "env outside allowlist leaked: {text:?}");
    let _ = fs::remove_dir_all(w.parent().unwrap());
}
```

Each marker lives INSIDE the single writable root `w`, so the child can write it; `/etc` stays read-only via the default `--ro-bind / /`. Note the network test's `FAILED` branch is what must be written — if the child could reach the fixture listener it writes `CONNECTED`, which the assertion rejects. The environment test asserts the allowlist end-to-end: `SECRET` exists in the broker's own (test-process) environment, but because the launch request's `environment` map is the only thing forwarded through `--setenv` under `--clearenv`, the sandboxed child must not see it.

- [ ] **Step 6: Run, watch them pass/fail** — `cargo test -p ultracode-sandbox-broker`. On the reference host with `bwrap` present these launch real sandboxes; without `bwrap` they print `SKIP` and pass vacuously.

- [ ] **Step 7: Clippy + Commit**

```bash
cargo clippy -p ultracode-sandbox-broker -- -D warnings
git add crates/ultracode-sandbox-broker/Cargo.toml crates/ultracode-sandbox-broker/Cargo.lock crates/ultracode-sandbox-broker/src/unix.rs crates/ultracode-sandbox-broker/src/unix/linux.rs crates/ultracode-sandbox-broker/src/lib.rs crates/ultracode-sandbox-broker/tests/linux_bwrap.rs
git commit -m "feat(ultracode-sandbox-broker): linux bubblewrap backend"
```

---

### Task 4: macOS seatbelt backend (Rust)

**Files:**
- Create: `crates/ultracode-sandbox-broker/src/unix/macos.rs`
- Create: `crates/ultracode-sandbox-broker/src/unix/macos_profile.rs` (pure profile generator — highly unit-testable)
- Modify: `crates/ultracode-sandbox-broker/src/lib.rs` (wire `#[cfg(target_os = "darwin")]` to `unix::macos`)
- Create: `crates/ultracode-sandbox-broker/tests/macos_seatbelt.rs`

**Interfaces:**
- Consumes: `Request`/`Response`/`Roots`/capability constants (Task 2); `unix::{spawn_in_new_pgid, kill_pgid, is_wsl}` (Task 3).
- Produces:
  - `macos_profile::build_profile(read_roots: &[String], writable_roots: &[String], network: &str) -> String` — pure seatbelt source.
  - `macos::probe(request_id) -> Response` — `ready` with `["explicit-environment", "writable-root", "network-deny", "seatbelt-profile"]` when `/usr/bin/sandbox-exec` exists and a minimal profile compiles; else `unsupported`.
  - `macos::launch(request) -> Response` — `sandbox-exec -p <profile> -- <executable> <args...>` in a new process group.
  - `macos::terminate(request) -> Response` — process-group kill (Task 3 helper).
  - macOS `probe`/`launch`/`terminate` wired into `lib.rs` behind `#[cfg(target_os = "darwin")]`.

- [ ] **Step 1: Write the failing unit tests** — inline in `crates/ultracode-sandbox-broker/src/unix/macos_profile.rs` under `#[cfg(test)]`:

```rust
#[test]
fn profile_is_closed_by_default() {
    let profile = build_profile(&[], &[], "allow");
    assert!(profile.contains("(deny default)"));
    assert!(profile.contains("(version 1)"));
}

#[test]
fn writable_roots_become_file_write_subpath_allows() {
    let profile = build_profile(&[], &["/workspace"], "allow");
    assert!(profile.contains("(allow file-write* (subpath \"/workspace\"))"));
    assert!(profile.contains("(allow file-read-metadata)"));
}

#[test]
fn network_deny_adds_deny_network() {
    let profile = build_profile(&[], &[], "deny");
    assert!(profile.contains("(deny network*)"));
}

#[test]
fn broad_read_root_allows_whole_root_else_per_root() {
    assert!(build_profile(&["/"], &[], "allow").contains("(allow file-read* (subpath \"/\"))"));
    let narrow = build_profile(&["/home/u"], &[], "allow");
    assert!(narrow.contains("(allow file-read* (subpath \"/home/u\"))"));
    assert!(!narrow.contains("(allow file-read* (subpath \"/\"))"));
}
```

- [ ] **Step 2: Run, watch fail** — `cargo test -p ultracode-sandbox-broker` → module missing.

- [ ] **Step 3: Implement the generator** — `macos_profile.rs`:

```rust
use super::macos_profile;

pub fn build_profile(read_roots: &[String], writable_roots: &[String], network: &str) -> String {
    let mut lines = vec![
        "(version 1)".to_string(),
        "(deny default)".to_string(),
        "(allow process-exec)".to_string(),
        "(allow process-fork)".to_string(),
        "(allow signal (target same-sandbox))".to_string(),
        "(allow file-read-metadata)".to_string(),
        "(allow file-read* (subpath \"/\"))".to_string(),
    ];
    if !read_roots.iter().any(|r| r == "*" || r == "/") {
        lines.retain(|line| line != "(allow file-read* (subpath \"/\"))");
        for read in read_roots {
            lines.push(format!("(allow file-read* (subpath \"{}\"))", read));
        }
    }
    for writable in writable_roots {
        lines.push(format!("(allow file-write* (subpath \"{}\"))", writable));
    }
    if network == "deny" {
        lines.push("(deny network*)".to_string());
    }
    lines.push("(allow sysctl-read)".to_string());
    lines.join("\n")
}
```

(The mandate's "readable roots default-allow+deny overrides" is implemented as: default-allow full reads when a broad root (`*` or `/`) is present, per-root subpath allows otherwise — everything not allowed stays denied by `(deny default)`. Note: writable roots are re-joined by the retain; keep the build simple and let the unit tests own the exact string.)

- [ ] **Step 4: Run, watch pass** — `cargo test -p ultracode-sandbox-broker`.

- [ ] **Step 5: Implement `macos.rs` launch/probe/terminate** — replace the Task 3 stub in `src/unix/macos.rs`:
  - `const SEATBELT: &str = "/usr/bin/sandbox-exec";` (fixed path — never `PATH` lookup, so a malicious `sandbox-exec` cannot be injected; reimplementation of the Codex invariant).
  - `macos::probe`: `is_wsl()` → `unsupported` (WSL has no seatbelt). If `Path::new(SEATBELT)` is not executable → `unsupported`. Compile-probe: run `SEATBELT -p '(version 1) (deny default)' /bin/true` with a 2s timeout; exit 0 → `ready` with `[CAP_EXPLICIT_ENVIRONMENT, CAP_WRITABLE_ROOT, CAP_NETWORK_DENY, CAP_SEATBELT_PROFILE]`; else `unsupported`.
  - `macos::launch`: build `profile = build_profile(&roots.read, &roots.writable, network)`, argv = `[SEATBELT, "-p", profile, executable, ...args]` (the `-p` flag takes the profile inline — no temp file). Validate `cwd` inside a writable root; spawn via `unix::spawn_in_new_pgid`; respond `started` with `job_id = pid`, `containment: Some("contained")`. `io::Error` → `failed`. **Environment allowlist on macOS is enforced by the broker, not seatbelt** (seatbelt cannot inspect env): only the request's `environment` map is passed to the child; document this in a `// NOTE` comment.
  - `macos::terminate`: same process-group kill as Linux; unknown `job_id` → `denied`.

- [ ] **Step 6: Write the integration test** — `crates/ultracode-sandbox-broker/tests/macos_seatbelt.rs` (`#![cfg(target_os = "darwin")]`), same skip pattern as `linux_bwrap.rs` but gated on `sandbox-exec` presence:
  - `network_denied_child_cannot_reach_fixture_listener` — identical shape to the Linux test (child tries `/dev/tcp/127.0.0.1/<port>`, asserts `FAILED`).
  - `write_outside_writable_root_fails` — child tries `touch /etc/pwned`, asserts `BLOCKED` (with `(deny default)` + no `file-write*` allow for `/etc`).

- [ ] **Step 7: Run (skips on Linux), Clippy, Commit**

```bash
cargo test -p ultracode-sandbox-broker
cargo clippy -p ultracode-sandbox-broker -- -D warnings
git add crates/ultracode-sandbox-broker/src/unix/macos.rs crates/ultracode-sandbox-broker/src/unix/macos_profile.rs crates/ultracode-sandbox-broker/src/lib.rs crates/ultracode-sandbox-broker/tests/macos_seatbelt.rs
git commit -m "feat(ultracode-sandbox-broker): macos seatbelt backend"
```

---

### Task 5: TS Broker.launch wiring for unix + platform-aware supervisor + broker resolution

**Files:**
- Modify: `packages/ultracode-sandbox/src/sandbox.ts`
- Modify: `packages/ultracode-sandbox/src/native.ts`
- Modify: `packages/ultracode-sandbox/src/index.ts`
- Create: `packages/ultracode-sandbox/src/resolve.ts`
- Modify: `packages/ultracode-sandbox/test/broker.test.ts`
- Modify: `packages/ultracode-sandbox/test/native.test.ts`
- Create: `packages/ultracode-sandbox/test/resolve.test.ts`
- Create: `packages/ultracode-sandbox/test/broker-integration.test.ts`

**Interfaces:**
- Consumes: Task 1 characterization pins; Tasks 2–4 capability vocabulary and backends.
- Produces:
  - `Profile` gains `containment: "none" | "requested" | "required"` (canonical); `windowsContainment` retained as a backwards-compatible alias — effective containment = `containment ?? windowsContainment ?? "none"`.
  - `Sandbox.Profile.basic(input)` constructor for contained profiles.
  - `BrokerCapability` union gains `"bwrap" | "bwrap-netns" | "seatbelt-profile"`.
  - `launchRequest(...)` and `BrokerRequest`'s `launch` carry `containment?: "required" | "requested"`; `BrokerResponse`'s `launch` gains `containment?: "contained" | "unconfined"` and `warning?: string`.
  - `LaunchPlan` gains `warnings?: readonly string[]` (journalable degradation warnings).
  - `Broker.requiredCapabilities(profile, platform)` — pure, unit-tested.
  - `NativeSupervisor.create({ path, platform? })`; `ensureForProfile` platform-aware (unix requires `explicit-environment` + mechanism cap + conditional `writable-root`/`network-deny`).
  - `resolveBrokerBin(opts?: { env?: NodeJS.ProcessEnv }): Promise<string>` + `BrokerNotFoundError` — candidate order: `env.ULTRACODE_SANDBOX_BROKER` → `Global.Path.bin/ultracode-sandbox-broker` (if `@opencode-ai/core/global` importable without cycle) → bundled `import.meta.dir/../../bin/ultracode-sandbox-broker` → `target/release/ultracode-sandbox-broker` / `target/debug/ultracode-sandbox-broker` via upward walk from cwd → `PATH`. Throws `BrokerNotFoundError` listing probed paths + the env hint. (RUN-01 has NOT landed — `packages/ultracode-events-client/src/resolve.ts` does not exist — so mirror the candidate-list approach RUN-01's Task 1 specifies, scoped to this binary.)

- [ ] **Step 1: Write the failing unit tests** — append to `packages/ultracode-sandbox/test/broker.test.ts`:

```ts
test("unix requested containment degrades to unconfined with a warning when capabilities are missing", () => {
  const broker = Sandbox.Broker.create({ platform: "linux" })
  const plan = broker.plan(request({ profile: contained({ containment: "requested" }) }))
  expect(plan).toMatchObject({ outcome: "allow", containment: "unconfined" })
  expect((plan as any).warnings?.length).toBeGreaterThan(0)
})

test("unix required containment denies when capabilities are missing", () => {
  const broker = Sandbox.Broker.create({ platform: "linux" })
  expect(broker.plan(request({ profile: contained({ containment: "required" }) }))).toMatchObject({
    outcome: "deny",
    reason: "containment-unsupported",
  })
})

test("unix required containment with all capabilities allows contained", () => {
  const broker = Sandbox.Broker.create({
    platform: "linux",
    capabilities: ["explicit-environment", "writable-root", "network-deny", "bwrap", "bwrap-netns"],
    containment: () => ({ outcome: "allow" }),
  })
  const plan = broker.plan(request({ profile: contained({ containment: "required" }) }))
  expect(plan).toMatchObject({ outcome: "allow", containment: "contained" })
})

test("windows containment never degrades to unconfined", () => {
  const broker = Sandbox.Broker.create({ platform: "win32" })
  expect(broker.plan(request({ profile: contained({ containment: "requested" }) }))).toMatchObject({
    outcome: "deny",
    reason: "containment-unsupported",
  })
})

test("requiredCapabilities are platform-specific", () => {
  expect(Sandbox.Broker.requiredCapabilities(contained({ containment: "required" }), "linux")).toEqual([
    "explicit-environment", "bwrap", "writable-root", "network-deny", "bwrap-netns",
  ])
  expect(Sandbox.Broker.requiredCapabilities(contained({ containment: "required", network: "allow" }), "darwin")).toEqual([
    "explicit-environment", "seatbelt-profile", "writable-root",
  ])
})
```

Update the `contained()` helper to include `containment: "required"` by default and drop `windowsContainment` from it (use the new field; the existing win32 tests that pass `windowsContainment` keep working through the alias). **The existing test `rejects Windows containment when the selected platform cannot enforce it` (platform `linux`, `contained({ windowsContainment: "requested" })`, no capabilities) now changes expectation** from `deny` to `{ outcome: "allow", containment: "unconfined", warnings: [...] }` — update it to use the new `containment` field and the new expectation.

- [ ] **Step 2: Run, watch fail** — `cd packages/ultracode-sandbox && bun test test/broker.test.ts` (containment field + new plan behavior missing).

- [ ] **Step 3: Implement `sandbox.ts`**
  - `WindowsContainment` type stays. Add `containment` to `Profile` (optional, union `"none" | "requested" | "required"`).
  - `Profile.basic(input)` and keep `Profile.unconfined()` (sets `mode: "unconfined"`, `containment: "none"`).
  - Effective containment helper: `const effectiveContainment = (profile) => profile.containment ?? profile.windowsContainment ?? "none"`.
  - `Broker.requiredCapabilities(profile, platform)`:
    ```ts
    export const requiredCapabilities = (profile: Profile, platform: Platform): ReadonlyArray<BrokerCapability> => {
      const base = platform === "win32"
        ? ["job-object-atomic", "explicit-environment", "restricted-token"]
        : platform === "linux"
          ? ["explicit-environment", "bwrap"]
          : ["explicit-environment", "seatbelt-profile"]
      return [
        ...base,
        ...(profile.writableRoots.length > 0 ? ["writable-root"] : []),
        ...(profile.network === "deny"
          ? platform === "linux" ? ["network-deny", "bwrap-netns"] : ["network-deny"]
          : []),
      ] as BrokerCapability[]
    }
    ```
  - Replace the body of `plan` (lines 86–117) with the following complete function. It preserves the win32 behavior of the current code verbatim (the current lines 91–107 logic is kept inside the `win32` branch and after it) while adding the unix degradation policy:
    ```ts
    function plan(request: LaunchRequest, options: BrokerOptions): Plan {
      if (request.authorization !== "allow") return denied("authorization-not-allowed")
      const policy = options.policy?.(request)
      if (policy?.outcome === "deny") return denied(policy.reason ?? "network-policy")
      if (request.profile.mode === "unconfined") return allowed(request, "unconfined")
      const containment = effectiveContainment(request.profile)
      const required = Broker.requiredCapabilities(request.profile, options.platform ?? "linux")
      const available = options.capabilities ?? []
      const missing = required.filter((capability) => !available.includes(capability))
      if (options.platform === "win32") {
        if (request.profile.windowsContainment !== "none" && !options.capabilities)
          return denied("containment-unsupported")
        if (options.wsl || !options.containment) return denied("containment-unsupported")
        if (
          request.profile.windowsContainment !== "none" &&
          request.profile.network === "deny" &&
          !options.capabilities?.includes("network-deny")
        )
          return denied("network-policy")
        if (
          request.profile.windowsContainment !== "none" &&
          request.profile.writableRoots.length > 0 &&
          !options.capabilities?.includes("writable-root")
        )
          return denied("cwd-outside-writable-roots")
      } else {
        if (options.wsl) return denied("containment-unsupported")
        if (containment === "required" && missing.length > 0)
          return denied(missing.includes("network-deny") ? "network-policy" : "containment-unsupported")
        if (containment === "requested" && missing.length > 0)
          return allowed(request, "unconfined", [
            `sandbox containment requested but unavailable (missing: ${missing.join(", ")}); running unconfined`,
          ])
      }
      if (!isAllowedExecutable(request.executable, request.profile.allowedExecutables))
        return denied("executable-not-allowed")
      if (!contains(request.cwd, request.profile.readRoots, options.platform, options.resolvePath))
        return denied("cwd-outside-readable-roots")
      if (!contains(request.cwd, request.profile.writableRoots, options.platform, options.resolvePath))
        return denied("cwd-outside-writable-roots")
      const backend = options.containment
      if (!backend) return denied("containment-unsupported")
      if (backend(request).outcome === "deny") return denied("containment-unsupported")
      return allowed(request, "contained")
    }
    ```
    Note: for `containment === "none"` on a non-unconfined profile the function falls through to the policy validation (executable/cwd checks still run) and then requires a backend to report `contained`; without a backend it returns `denied("containment-unsupported")` at the final `if (!backend)` check — this preserves the existing `broker.test.ts` expectations for profiles with restrictions but no engagement request when no backend is configured. If you prefer `none` to allow unconfined without a backend, record that as a deviation; the mandate only mandates `required`/`requested` semantics.
  - `allowed(request, containment, warnings?)` sets `warnings` on the `LaunchPlan` when provided:
    ```ts
    function allowed(
      request: LaunchRequest,
      containment: LaunchPlan["containment"],
      warnings?: ReadonlyArray<string>,
    ): LaunchPlan {
      return {
        outcome: "allow",
        executable: request.executable,
        args: request.args,
        cwd: request.cwd,
        environment: filterEnvironment(request.environment, request.profile.environment),
        containment,
        ...(warnings ? { warnings } : {}),
      }
    }
    ```
  - `LaunchPlan` gains `warnings?: readonly string[]`; `BrokerOptions`/`Broker.create` unchanged; `Broker` namespace gains `requiredCapabilities`.

- [ ] **Step 4: Run, watch pass** — `cd packages/ultracode-sandbox && bun test test/broker.test.ts`; then fix any other changed linux expectations in the file (the characterization pins from Task 1 that asserted strict-deny on linux without capabilities now reflect the new policy — update exactly the ones the new contract changes and record in the deviation log).

- [ ] **Step 5: Update `native.ts`** (TDD: extend `native.test.ts` first, run-fail, then implement)
  - Add `"bwrap" | "bwrap-netns" | "seatbelt-profile"` to `BrokerCapability` + `isCapability`.
  - `launchRequest(...)` and `BrokerRequest.launch` gain `containment?: "required" | "requested"`.
  - `BrokerResponse.launch` gains `containment?: "contained" | "unconfined"`, `warning?: string`; `parseBrokerResponse` accepts them.
  - `NativeSupervisor.create({ path, platform? })`; `ensureForProfile` uses `platform`:
    ```ts
    ensureForProfile: (profile) =>
      platform === "win32"
        ? ensure(["job-object-atomic", "explicit-environment", "restricted-token",
            ...(profile.writableRoots.length ? ["writable-root"] : []),
            ...(profile.network === "deny" ? ["network-deny"] : [])])
        : ensure(requiredCapabilities(profile, platform)),
    ```
  - Replace the Task 1 characterization pin in `native.test.ts` with the new platform-aware assertion (unix profile over a linux-ready broker resolves the unix caps).

- [ ] **Step 6: Broker binary resolution** — `src/resolve.ts` implementing the `resolveBrokerBin` contract above (mirror the `resolveSidecarBin` approach RUN-01 Task 1 specifies; the binary name here is `ultracode-sandbox-broker`). Write the failing test first — `test/resolve.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BrokerNotFoundError, resolveBrokerBin } from "../src/resolve"

function fakeBin(dir: string, name: string) {
  mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  writeFileSync(p, "#!/bin/sh\nexit 0\n")
  chmodSync(p, 0o755)
  return p
}

describe("resolveBrokerBin", () => {
  test("env override wins when it points at an executable file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "broker-resolve-"))
    const bin = fakeBin(dir, process.platform === "win32" ? "ultracode-sandbox-broker.exe" : "ultracode-sandbox-broker")
    const found = await resolveBrokerBin({ env: { ULTRACODE_SANDBOX_BROKER: bin } })
    expect(found).toBe(bin)
  })

  test("env override pointing at a missing file is rejected, not silently skipped", async () => {
    await expect(
      resolveBrokerBin({ env: { ULTRACODE_SANDBOX_BROKER: "/no/such/path/ultracode-sandbox-broker" } }),
    ).rejects.toBeInstanceOf(BrokerNotFoundError)
  })

  test("not found anywhere → error names probed paths and the env hint", async () => {
    try {
      await resolveBrokerBin({ env: {} })
      expect.unreachable("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerNotFoundError)
      expect(String((e as Error).message)).toContain("ULTRACODE_SANDBOX_BROKER")
    }
  })
})
```

Run `cd packages/ultracode-sandbox && bun test test/resolve.test.ts` → FAIL (module missing), then implement `src/resolve.ts` (happy-path-first export; candidates in one ordered array; `Bun.file(p).exists()` + `fs.accessSync(p, fs.constants.X_OK)` on posix, skip `X_OK` on win32; upward walk from `process.cwd()` looking at `target/release` and `target/debug`), run → PASS.

- [ ] **Step 7: TS integration test** — `test/broker-integration.test.ts` (skips unless `process.platform === "linux"` AND a broker binary resolves AND `bwrap` is present). Each fail-closed test launches a real contained child through the broker, observes the child's verdict via a marker file written inside the child's single writable root (`dir`, which is also the cwd), then `terminate`s the child through the broker (covering TS-side child supervision/terminate):

```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createNativeBroker, launchRequest, type NativeBroker } from "../src/native"
import { resolveBrokerBin } from "../src/resolve"

const available = await (async () => {
  if (process.platform !== "linux") return false
  try { await resolveBrokerBin({}) } catch { return false }
  return (await import("bun")).which("bwrap") !== null
})()

const waitForMarker = async (file: string, ms = 8000): Promise<string> => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try { return readFileSync(file, "utf8") } catch {}
    await Bun.sleep(50)
  }
  return ""
}

async function runChild(broker: NativeBroker, script: string, network: "allow" | "deny"): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "sandbox-it-"))
  const file = path.join(dir, "outcome")
  const response = await broker.request(
    launchRequest("it-launch", "/bin/bash", ["-c", script], dir, ["/"], [dir], { PATH: "/usr/bin:/bin" }, network),
  )
  expect(response.outcome).toBe("started")
  expect(response.containment).toBe("contained")
  const text = await waitForMarker(file)
  await broker.request({ version: 1, request_id: "it-terminate", method: "terminate", job_id: response.job_id! })
  return text
}

describe.skipIf(!available)("sandbox broker unix integration", () => {
  test("network_denied_process_cannot_reach_fixture_tcp_listener", async () => {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } })
    const port = (listener as { port: number }).port
    const broker = createNativeBroker(await resolveBrokerBin({}))
    const verdict = await runChild(
      broker,
      `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo CONNECTED > outcome || echo FAILED > outcome`,
      "deny",
    )
    broker.close()
    listener.stop(true)
    expect(verdict.trim()).toBe("FAILED")
  })

  test("write_outside_writableRoots_fails", async () => {
    const broker = createNativeBroker(await resolveBrokerBin({}))
    const verdict = await runChild(
      broker,
      `touch /etc/pwned 2>/dev/null && echo WROTE > outcome || echo BLOCKED > outcome`,
      "allow",
    )
    broker.close()
    expect(verdict.trim()).toBe("BLOCKED")
  })

  test("env_outside_allowlist_is_absent_in_child", async () => {
    const broker = createNativeBroker(await resolveBrokerBin({}))
    const leaked = await runChild(broker, `printf '%s' "$SECRET" > outcome`, "allow")
    broker.close()
    expect(leaked).toBe("")
  })
})
```

Containment notes: `dir` is the only writable root, so `/etc` stays read-only (the read-only root default `--ro-bind / /`) and `touch /etc/pwned` must fail; the child's own marker writes go to `dir`, which is writable. The `environment` map passed to `launchRequest` IS the allowlist the broker forwards through `--setenv` — it contains only `PATH`, so `$SECRET` is unset in the child; a broker that leaked parent env would fail this test. These integration tests run against the REAL broker binary resolved by `resolveBrokerBin`; before Task 7 lands, the candidate list includes the repo-root `target/release` / `target/debug` walk, so `cargo build -p ultracode-sandbox-broker` makes them runnable locally. If neither artifact exists, the tests skip — correct until Task 7 packages the binary.

- [ ] **Step 8: Full suite + typecheck + commit**

```bash
cd packages/ultracode-sandbox && bun test && bun typecheck
git add packages/ultracode-sandbox/src packages/ultracode-sandbox/test
git commit -m "feat(ultracode-sandbox): unix containment plan policy, platform-aware supervisor, broker resolution"
```

---

### Task 6: Engagement at bash + PTY call sites from the permission profile

**Files:**
- Modify: `packages/schema/src/agent.ts` (`Agent.Info` gains `sandbox`)
- Modify: `packages/core/src/config/agent.ts` (`ConfigAgent.Info` gains `sandbox`)
- Modify: `packages/core/src/config/plugin/agent.ts` (map config `sandbox` → `Agent.Info.sandbox`; add `"sandbox"` to `agentKeys`)
- Modify: `packages/core/src/sandbox.ts` (`SandboxProcess` service: `profileFor`, unix `prepare`, broker resolution)
- Modify: `packages/core/src/tool/bash.ts` (plan call site)
- Modify: `packages/core/src/pty.ts` (plan call site)
- Modify: `packages/core/test/tool-bash.test.ts` (stub gains `profileFor`)
- Modify: `packages/core/test/pty/pty-session.test.ts` (stub gains `profileFor`)
- Create: `packages/core/test/sandbox.test.ts`
- Create: `packages/core/test/tool-bash-sandbox.test.ts`

**Interfaces:**
- Consumes: `Sandbox.Profile`, `Sandbox.Broker.requiredCapabilities`, `resolveBrokerBin`, `BrokerNotFoundError` (Task 5); `Agent.Info`/`ConfigAgent.Info` (modified here); `AgentV2.Service` (for agent resolution in `SandboxProcess`).
- Produces:
  - `Agent.Info.sandbox?: "none" | "requested" | "required"`.
  - `ConfigAgent.Info.sandbox?: "none" | "requested" | "required"`.
  - `SandboxProcess.Interface`:
    ```ts
    readonly plan: (request: Sandbox.LaunchRequest) => Sandbox.Plan
    readonly prepare?: (request: Sandbox.LaunchRequest) => Promise<Sandbox.Plan>
    readonly profileFor: (agent: AgentV2.Info | undefined, workspaceRoot: string) => Sandbox.Profile
    ```
  - `SandboxProcess.profileFor` contract (pure, in `packages/core/src/sandbox.ts`):
    - no agent → `Sandbox.Profile.unconfined()`
    - `agent.sandbox === "none"` and no `agent.permissionProfile?.sandboxProfile` → `Sandbox.Profile.unconfined()`
    - else → `Sandbox.Profile.basic({ writableRoots: [workspaceRoot], readRoots: ["/"], network: "allow", containment: agent.sandbox ?? "requested" })`
    - (A non-empty `sandboxProfile` string maps to this default profile; named-profile definitions are a RUN-13 concern — document this in the doc comment.)
  - `SandboxProcess` layer yields `AgentV2.Service`, adds `AgentV2.node` to its deps, and its `prepare` becomes: probe the native broker for the profile's capabilities (via `resolveBrokerBin` + `NativeSupervisor`, platform-aware), then delegate to `Sandbox.Broker.create({ platform, wsl, capabilities, ... }).plan(request)` — the degradation policy from Task 5 does the `required`→deny / `requested`→unconfined+warn work.
  - bash call site (contained path): `executable: shell`, `args: ["-c", input.command]`, `shell: false`; unconfined path byte-identical to today.
  - PTY call site: `sandbox.profileFor(undefined, cwd)` (Location-level default; PTY.create has no agent context today — recorded limitation; containment config still honored when it arrives via `profileFor` in a later run).

- [ ] **Step 1: Failing schema/config tests** — add to `packages/core/test/config/` (or extend the existing agent config test file you find there) an assertion that a config agent document with `sandbox: "required"` produces `Agent.Info.sandbox === "required"`; add to a new `packages/core/test/sandbox.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { SandboxProcess } from "@opencode-ai/core/sandbox"

const agent = (sandbox: "none" | "requested" | "required" | undefined, sandboxProfile?: string) => ({
  sandbox,
  permissionProfile: sandboxProfile ? { sandboxProfile } : undefined,
})

describe("SandboxProcess.profileFor", () => {
  test("no agent resolves unconfined", () => {
    expect(SandboxProcess.profileFor(undefined, "/workspace").mode).toBe("unconfined")
  })
  test("sandbox none with no profile resolves unconfined", () => {
    expect(SandboxProcess.profileFor(agent("none") as any, "/workspace").mode).toBe("unconfined")
  })
  test("sandbox required resolves a contained profile with the workspace writable", () => {
    const profile = SandboxProcess.profileFor(agent("required") as any, "/workspace")
    expect(profile).toMatchObject({ writableRoots: ["/workspace"], readRoots: ["/"], containment: "required" })
    expect(profile.mode).not.toBe("unconfined")
  })
  test("sandboxProfile alone resolves a contained profile with requested containment", () => {
    const profile = SandboxProcess.profileFor(agent(undefined, "default") as any, "/workspace")
    expect(profile).toMatchObject({ containment: "requested" })
  })
})
```

- [ ] **Step 2: Run, watch fail** — `cd packages/core && bun test test/sandbox.test.ts` (module/function missing).

- [ ] **Step 3: Implement schema + config + `profileFor`**
  - `packages/schema/src/agent.ts`: add `sandbox: Schema.Union([Schema.Literals(["none", "requested", "required"])]).pipe(optional)` to `Agent.Info` (import `optional` like the file already does).
  - `packages/core/src/config/agent.ts`: add `sandbox: Schema.Union([Schema.Literals(["none", "requested", "required"])]).pipe(Schema.optional)` to `ConfigAgent.Info`.
  - `packages/core/src/config/plugin/agent.ts`: add `"sandbox"` to `agentKeys`; in the `if (item.permissionProfile !== undefined)` block area add `if (item.sandbox !== undefined) agent.sandbox = item.sandbox`.
  - `packages/core/src/sandbox.ts`: add `profileFor` (pure, exported at namespace level so the test imports it without building the layer) and thread `workspaceRoot`. Add `AgentV2.node` to deps; yield `AgentV2.Service` in the layer only for the `prepare` path that needs it (profileFor is pure and takes `Agent.Info` directly, so it needs no service).
  - If `Agent.Info` appears in generated client types, run `cd packages/client && bun run generate` and `bun run check:generated` per the repo rule; otherwise note that no regeneration was needed.

- [ ] **Step 4: Wire bash** — in `packages/core/src/tool/bash.ts`:
  - Resolve `shell` BEFORE planning (move the existing `config.entries()` + `shell` computation up).
  - Resolve the agent: `const agents = yield* AgentV2.Service`; `const agent = yield* agents.resolve(context.agent)`; `const profile = sandbox.profileFor(agent, target.canonical)`.
  - Plan:
    ```ts
    const plan =
      profile.mode === "unconfined"
        ? sandbox.plan({
            authorization: "allow", profile,
            executable: input.command, args: [], cwd: target.canonical, environment: process.env,
          })
        : sandbox.plan({
            authorization: "allow", profile,
            executable: shell, args: ["-c", input.command], cwd: target.canonical, environment: process.env,
          })
    if (plan.outcome === "deny") return yield* Effect.fail(new Error(`Sandbox denied command: ${plan.reason}`))
    for (const warning of plan.warnings ?? []) yield* Effect.logWarning("sandbox containment degraded", { warning })
    const command = ChildProcess.make(plan.executable, plan.args, {
      cwd: plan.cwd,
      shell: profile.mode === "unconfined" ? shell : false,
      env: plan.environment,
      stdin: "ignore",
      detached: process.platform !== "win32",
      forceKillAfter: Duration.seconds(3),
    })
    ```
  - Add `AgentV2.Service` to the yielded services and `AgentV2.node` to `BashTool.node` deps.

- [ ] **Step 5: Wire PTY** — in `packages/core/src/pty.ts`, replace `profile: SandboxProcess.unconfinedProfile` with:
  ```ts
  const profile = sandbox.profileFor(undefined, cwd)
  const plan = sandbox.plan({ authorization: "allow", profile, executable: command, args, cwd, environment: env })
  ```
  and log `plan.warnings` via `Effect.logWarning` before spawning. PTY keeps using the direct `spawn(plan.executable, [...plan.args])` — a contained PTY launches `bwrap/sandbox-exec <shell> <args...>` directly (PTY argv is already concrete, no shell-wrapping needed).

- [ ] **Step 6: Fix the stubs + add a bash sandbox test**
  - `packages/core/test/tool-bash.test.ts`: the `sandbox` stub gains `profileFor: () => SandboxProcess.unconfinedProfile`; add `AgentV2.node` to the `LayerNode.group([...])` (AgentV2.node has no deps).
  - `packages/core/test/pty/pty-session.test.ts`: the `SandboxProcess.Service.of({...})` stub gains `profileFor: () => SandboxProcess.unconfinedProfile`.
  - New `packages/core/test/tool-bash-sandbox.test.ts`: a bash call with a stub `SandboxProcess` whose `profileFor` returns a `containment: "required"` profile and whose `plan` returns `{ outcome: "deny", reason: "containment-unsupported" }` → the tool fails with `Sandbox denied command: containment-unsupported`. Second test: `plan` returns `{ outcome: "allow", containment: "unconfined", warnings: ["..."] }` → the command still runs and the warning was logged (assert via the `runs` recorder that `shell` is `false` and `command.command` is the shell path, `args[0] === "-c"`).

- [ ] **Step 7: Run + typecheck + commit**

```bash
cd packages/core && bun test test/sandbox.test.ts test/tool-bash.test.ts test/tool-bash-sandbox.test.ts test/pty/pty-session.test.ts && bun typecheck
git add packages/schema/src/agent.ts packages/core/src/config/agent.ts packages/core/src/config/plugin/agent.ts packages/core/src/sandbox.ts packages/core/src/tool/bash.ts packages/core/src/pty.ts packages/core/test
git commit -m "feat(core): engage sandbox containment at bash and pty call sites from the agent profile"
```

---

### Task 7: Packaging the broker into CLI builds + binary resolution

**Files:**
- Modify: `crates/ultracode-sandbox-broker/Cargo.toml` (`[[bin]]` name)
- Modify: `packages/opencode/script/build.ts` (stage the broker beside `opencode`)
- Modify: `packages/ultracode-sandbox/src/resolve.ts` (ensure the packaged path is in the candidate list)
- Modify: `packages/core/src/sandbox.ts` (consume `resolveBrokerBin`)
- Test: `packages/ultracode-sandbox/test/resolve.test.ts` (extend for the packaged path)

**Interfaces:**
- Consumes: `resolveBrokerBin` candidate list (Task 5).
- Produces: host-target artifact `dist/<triple>/bin/ultracode-sandbox-broker` when running `bun run script/build.ts --single`; the packaged path is one of `resolveBrokerBin`'s candidates (bundled `bin/` next to the executable is reached via the `import.meta.dir/../../bin/` candidate).

- [ ] **Step 1: Fix the binary name** — in `crates/ultracode-sandbox-broker/Cargo.toml` add:

```toml
[[bin]]
name = "ultracode-sandbox-broker"
path = "src/bin/broker.rs"
```

Verify: `cargo build --release -p ultracode-sandbox-broker` produces `target/release/ultracode-sandbox-broker`.

- [ ] **Step 2: Failing verification** — the "test" for this task is a scripted assertion. Add to `packages/ultracode-sandbox/test/resolve.test.ts`:

```ts
test("resolves the packaged binary under a dist bundle layout", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "broker-dist-"))
  const binDir = path.join(dir, "bin")
  const bin = fakeBin(binDir, process.platform === "win32" ? "ultracode-sandbox-broker.exe" : "ultracode-sandbox-broker")
  // The bundled candidate is relative to import.meta.dir/../../bin; simulate by setting the env override.
  const found = await resolveBrokerBin({ env: { ULTRACODE_SANDBOX_BROKER: bin } })
  expect(found).toBe(bin)
})
```

- [ ] **Step 3: Implement the build step** — in `packages/opencode/script/build.ts`, inside the per-target loop (next to the existing `mkdir -p dist/${name}/bin`), after the Bun.build:

```ts
const brokerTarget = item.os === "win32" ? `x86_64-pc-windows-msvc` : item.os === "darwin" ? `aarch64-apple-darwin` : `x86_64-unknown-linux-gnu`
await $`cargo build --release -p ultracode-sandbox-broker --target ${brokerTarget}`
await $`cp target/${brokerTarget}/release/ultracode-sandbox-broker dist/${name}/bin/ultracode-sandbox-broker`
```

(The exact triple handling: use a small helper mapping the `item` shape to a Rust target triple; keep it simple and record that the broker is cross-compiled per-target exactly like the sidecar pattern RUN-01 Task 7 specifies. If a target's Rust toolchain is unavailable in the current environment, the `--single` host-target path must still succeed — gate the cross-target builds behind the same `singleFlag`/host-target condition as the smoke test.)

- [ ] **Step 4: Run, watch pass** — `cd packages/opencode && bun run script/build.ts --single --skip-embed-web-ui --skip-install`; then assert `ls dist/<host-triple>/bin/ultracode-sandbox-broker` and that the artifact answers a probe:

```bash
printf '%s\n' '{"version":1,"request_id":"r1","method":"probe"}' | dist/<host-triple>/bin/ultracode-sandbox-broker
```

(On the reference Linux host this prints a `ready` probe with the `bwrap` capabilities.)

- [ ] **Step 5: Wire resolution in core** — `packages/core/src/sandbox.ts`: replace the `process.env.ULTRACODE_SANDBOX_BROKER`-only supervisor construction with a `resolveBrokerBin()` call (async, cached once per process), used on win32 AND linux/darwin when a contained profile is requested. Keep the degrade path: resolution failure → `prepare` reports `containment-unsupported` (the Task 5 policy then degrades `requested` to unconfined-with-warning and denies `required`).

- [ ] **Step 6: Typecheck + commit**

```bash
cd packages/opencode && bun typecheck
git add crates/ultracode-sandbox-broker/Cargo.toml packages/opencode/script/build.ts packages/ultracode-sandbox/src/resolve.ts packages/ultracode-sandbox/test/resolve.test.ts packages/core/src/sandbox.ts
git commit -m "build(opencode): package and resolve the sandbox broker for release targets"
```

---

### Task 8: Provenance document + ledger (MANDATORY)

**Files:**
- Create: `docs/provenance/codex-unix-sandbox-2026-08-06.md`
- Create: `docs/provenance/sources.json`
- Create: `docs/provenance/ledger.json`

**Interfaces:**
- Consumes: `scripts/provenance/validate.ts` schema (Context File 17). NEITHER `sources.json` NOR `ledger.json` exists; the validator requires both, so this task creates them from scratch (the audit's R6 "complete the ledger retroactively" starts here).

- [ ] **Step 1: Write the provenance document** — `docs/provenance/codex-unix-sandbox-2026-08-06.md`, mirroring the Windows template's four sections, reimplemented for Linux+macOS. Content requirements (no text copied from `../codex`):

```markdown
# Codex Unix Sandbox Provenance

## Authorization

UltraCode RUN-09 uses an invariant-guided reimplementation of selected Codex
Linux bubblewrap and macOS seatbelt sandbox behavior. No Codex source files,
crates, policy templates, or helper binaries are imported.

- Source: `openai/codex`
- Audited revision: `9ea975a2dc88d039512313da3e332013e8bd911e`
- Audited crates: `codex-rs/sandboxing` (bwrap.rs, seatbelt.rs), `codex-rs/linux-sandbox` (bwrap.rs)
- License reviewed: Apache-2.0
- Port type: independent reimplementation of documented safety invariants
- Excluded: Codex app-server, proxy, policy language, launcher, and setup controllers

## Dependency Closure Audit

The required native invariants are based on Codex's bubblewrap and seatbelt
integration. Their complete workspace closure includes unrelated Codex
protocol, proxy, and launcher crates. UltraCode therefore depends only on
`serde`, `serde_json`, and `libc` (unix targets) in the standalone broker crate.

## Ported Invariants

- Probe the backend capability before advertising it (bubblewrap namespace
  probe; seatbelt profile compile probe); a failed probe is `unsupported`,
  never simulated.
- WSL remains unsupported and fails closed on every platform.
- Linux: read-only root by default (`--ro-bind / /`); writable roots layered
  with `--bind`; network deny via `--unshare-net`; environment allowlist
  enforced with `--clearenv` plus explicit `--setenv`.
- macOS: seatbelt profile is closed by default (`(deny default)`); writable
  roots become `file-write*` subpath allows; network deny via `(deny network*)`;
  `/usr/bin/sandbox-exec` is used by fixed path, never `PATH` resolution.
- A child runs in its own process group; terminate kills the whole group
  (process-group analogue of the Job Object tree termination invariant).
- The broker constructs the child environment from the approved allowlist only
  (on macOS, seatbelt cannot inspect environment; the broker enforces it).

## Explicit Limits

- A profile requiring denied network access is denied at plan time when the
  probed backend cannot enforce it; the broker never uses environment
  variables as a substitute for network enforcement.
- `containment: "required"` never degrades: it denies when the capability is
  unavailable. `containment: "requested"` degrades to unconfined only with an
  explicit journaled warning.
- Named `sandboxProfile` definitions beyond the built-in default are a RUN-13
  concern; RUN-09 maps any non-empty `sandboxProfile` to the default profile.
```

- [ ] **Step 2: Create `docs/provenance/sources.json`** — one source entry for codex (the validator requires a 40-char lowercase `pinned_commit`, and `repo_path` is optional for an external source):

```json
[
  {
    "id": "openai-codex",
    "repo_path": null,
    "remote_url": "https://github.com/openai/codex",
    "branch": "main",
    "pinned_commit": "9ea975a2dc88d039512313da3e332013e8bd911e",
    "license_spdx": "Apache-2.0",
    "license_file": null,
    "notice_file": null,
    "authorization_ref": null
  }
]
```

- [ ] **Step 3: Create `docs/provenance/ledger.json`** — one entry for this run (validator requires `version: 1`, unique `destination`, valid `imported_from_commit`, and matching `source_id`):

```json
{
  "version": 1,
  "imports": [
    {
      "id": "codex-unix-sandbox-2026-08-06",
      "source_id": "openai-codex",
      "original_path": "codex-rs/sandboxing/src/{bwrap.rs,seatbelt.rs}; codex-rs/linux-sandbox/src/bwrap.rs",
      "destination": "docs/provenance/codex-unix-sandbox-2026-08-06.md",
      "treatment": "reimplement",
      "owner": "ultracode",
      "imported_from_commit": "9ea975a2dc88d039512313da3e332013e8bd911e",
      "license_spdx": "Apache-2.0",
      "notice_required": false,
      "authorization_ref": null,
      "imported_at": "2026-08-06",
      "local_modifications": [],
      "upstream_merge_owner": "ultracode"
    }
  ]
}
```

- [ ] **Step 4: Validate (MANDATORY)**

Run: `bun run scripts/provenance/validate.ts` (from repo root, per the script's usage comment).
Expected: `PROVENANCE OK: sources=1 imports=1 warnings=0`.

- [ ] **Step 5: Commit**

```bash
git add docs/provenance/codex-unix-sandbox-2026-08-06.md docs/provenance/sources.json docs/provenance/ledger.json
git commit -m "docs(provenance): record unix sandbox reimplementation and ledger"
```

---

### Task 9: Docs + run ledger

**Files:**
- Create: `docs/sandbox.md`
- Modify: `TODO/README.md` (§7 Cross-Run Interface Registry, §8 Run Ledger)

**Interfaces:**
- Consumes: all produced interfaces from Tasks 1–8.

- [ ] **Step 1: Write `docs/sandbox.md`** — a concise operator + architect doc covering: the one-broker-three-platform model, the `probe`/`launch`/`terminate` protocol and its capabilities, `containment: none|requested|required` semantics (required never degrades; requested degrades with a warning), how `agent.sandbox` config + `permissionProfile.sandboxProfile` select a profile, WSL fail-closed, and the RUN-13 default-flip note. Reference `docs/provenance/codex-unix-sandbox-2026-08-06.md`.

- [ ] **Step 2: Update the cross-run registry** — in `TODO/README.md` §7 add a row:

```markdown
| RUN-09 | `SandboxProcess.profileFor(agent, workspaceRoot)` + `Profile.containment` + unix `BrokerCapability` set | `packages/core/src/sandbox.ts`, `packages/ultracode-sandbox/src/{sandbox,native,resolve}.ts` | RUN-13 |
```

- [ ] **Step 3: Update the run ledger** — in `TODO/README.md` §8 append:

```markdown
| RUN-09 | 2026-08-06 | <range> | <baselines green?> | <deviations> |
```

(fill commit range + baseline status + deviations after the run-level review passes).

- [ ] **Step 4: Verify + commit**

```bash
cd packages/ultracode-sandbox && bun test && bun typecheck
cd packages/core && bun test && bun typecheck
git add docs/sandbox.md TODO/README.md
git commit -m "docs: sandbox engagement documentation and run ledger"
```

---

## Run-Level Review Prompt (dispatch after Task 9)

```
Review the commits <list hashes> in /home/thymia/UltraCode-Planning/opencode
implementing RUN-09 (file: opencode/TODO/RUN-09-sandbox-unix.md).
Run-specific checks:
1. Fail-closed everywhere: `required` containment never degrades to unconfined;
   any degrade path for `requested` carries an explicit journaled warning.
   grep the diff for `unconfined` near `containment` and audit every branch.
2. WSL remains unsupported and fail-closed in TS Broker.plan AND in the Rust
   linux/macos probes.
3. The Rust protocol changes are additive only: no existing Windows request/
   response field was re-interpreted; `containment`/`warning` are optional.
4. The broker crate gains no runtime dependency beyond `libc` on unix
   (check Cargo.toml).
5. Integration tests for bwrap/seatbelt SKIP (early-return) rather than fail
   when the backend is absent.
6. Provenance: `bun run scripts/provenance/validate.ts` exits 0; the
   provenance document has all four template sections and no copied Codex text.
7. One-owner rule: no TS code writes journal files; the broker protocol is the
   only containment interface (no second spawn path added around the broker).
Then the generic checks from TODO/README.md §5.1 items 1–5.
Reply numbered findings, BLOCKER or MINOR, file:line. No edits.
```

## Deviation Log (fill during execution)

| Task | Deviation | Reason |
|---|---|---|
