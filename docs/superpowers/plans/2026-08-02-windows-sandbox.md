# Windows Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a fail-closed native Windows process-containment broker for approved UltraCode sandbox launches.

**Architecture:** TypeScript retains policy and serializes a filtered native request. A standalone Rust stdio broker independently validates and creates a restricted, Job-contained process; unavailable controls deny rather than fall back.

**Tech Stack:** Bun/TypeScript, Rust, `serde`, `serde_json`, `windows-sys`.

---

### Task 1: Record provenance and protocol

**Files:**
- Create: `docs/provenance/codex-windows-sandbox-2026-08-02.md`
- Create: `packages/ultracode-sandbox/src/native.ts`

- [ ] Define versioned `probe`, `launch`, and `terminate` request/response types.
- [ ] Encode only the policy-filtered executable, cwd, roots, environment, containment mode, and network requirement.
- [ ] Test serialization rejects invalid broker responses.

### Task 2: Create the native broker

**Files:**
- Create: `crates/ultracode-sandbox-broker/Cargo.toml`
- Create: `crates/ultracode-sandbox-broker/src/lib.rs`
- Create: `crates/ultracode-sandbox-broker/src/bin/broker.rs`

- [ ] Add newline-delimited JSON request dispatch.
- [ ] On Windows, create a kill-on-close Job Object before `CreateProcess` and include it in `PROC_THREAD_ATTRIBUTE_JOB_LIST`.
- [ ] Reject missing required restricted-token, writable-root, or WFP capabilities.
- [ ] On non-Windows, return an explicit unsupported response.

### Task 3: Supervise the broker from TypeScript

**Files:**
- Modify: `packages/ultracode-sandbox/src/sandbox.ts`
- Modify: `packages/core/src/sandbox.ts`
- Test: `packages/ultracode-sandbox/test/broker.test.ts`

- [ ] Start the broker through private stdio only after policy planning permits containment.
- [ ] Verify the reported version and enforcement capabilities for every request.
- [ ] Deny WSL, crash/disconnect, and unavailable required capabilities.

### Task 4: Add real-process Windows tests

**Files:**
- Create: `crates/ultracode-sandbox-broker/tests/windows_containment.rs`
- Test: `packages/ultracode-sandbox/test/native.test.ts`

- [ ] Verify a terminated Job Object kills a child and grandchild.
- [ ] Verify forbidden/reparse/UNC roots and unavailable enforcement fail before launch.
- [ ] Verify environment stripping uses the approved environment only.

### Task 5: Verify and ship

- [ ] Run `cargo fmt --check --workspace`.
- [ ] Run `cargo test -p ultracode-sandbox-broker` on Windows.
- [ ] Run `bun test` and `bun typecheck` in `packages/ultracode-sandbox` and `packages/core`.
- [ ] Run workspace `bun typecheck`, commit focused files, and push.
