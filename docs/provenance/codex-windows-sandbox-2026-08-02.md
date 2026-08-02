# Codex Windows Sandbox Provenance

## Authorization

UltraCode Stage 6 uses an invariant-guided reimplementation of selected Codex
Windows sandbox behavior. No Codex source files, crates, controllers, setup
helpers, or application-server code are imported.

- Source: `openai/codex`
- Audited revision: `9ea975a2dc88d039512313da3e332013e8bd911e`
- Audited Windows sandbox history revision: `6b23635a7e8d92862940702a2ec65c1226402cdb`
- License reviewed: Apache-2.0
- Port type: independent reimplementation of documented safety invariants
- Excluded: Codex app-server, CLI, session, setup, telemetry, and elevated
  identity controllers

Because no source is copied or derived, this implementation does not add a
Codex source attribution requirement. New Rust dependencies retain their own
license notices in their package metadata and release notices.

## Dependency Closure Audit

The required native invariants are based on Codex's Job Object, launch, token,
path-normalization, environment, and WFP components. Their complete workspace
closure includes unrelated Codex protocol, telemetry, PTY, and setup crates.
UltraCode therefore depends only on `serde`, `serde_json`, and `windows-sys` in
its standalone broker crate.

## Ported Invariants

- Create a Job Object before process creation and install it through
  `PROC_THREAD_ATTRIBUTE_JOB_LIST`.
- Set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; terminate the Job Object rather
  than an individual process.
- Reject containment when token, Job Object, path validation, or requested
  network enforcement cannot be installed.
- Canonicalize roots and reject ambiguous, UNC, reparse-point, or escaped
  paths before launch.
- Construct the child environment from the approved allowlist only.
- Treat WSL as unsupported for Windows containment.

## Explicit Limits

Windows Filtering Platform provisioning requires an administrative identity and
is not silently simulated. A profile requiring denied network access is denied
until an installed WFP enforcement capability reports ready. The broker never
uses environment variables as a substitute for network enforcement.
