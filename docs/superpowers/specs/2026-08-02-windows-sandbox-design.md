# Windows Sandbox Design

## Scope

Complete the remaining Stage 6 Windows enforcement work without broadening
Stage 7 or packaging the event sidecar.

## Architecture

`@ultracode/sandbox` remains the policy authority. It reduces an allowed
request to an immutable, filtered native launch request and sends it to a
short-lived, local stdio broker. The standalone `ultracode-sandbox-broker`
Rust binary validates the request again and is the only code that creates a
contained Windows process.

The broker creates a kill-on-close Job Object before the process and supplies
it during `CreateProcess` through `PROC_THREAD_ATTRIBUTE_JOB_LIST`, preventing
a child from escaping before later assignment. A restricted token is required
for contained launch. Ambiguous filesystem roots, reparse points, WSL, broker
protocol failures, unsupported containment, and unavailable required network
enforcement all deny the launch.

## Protocol

The private newline-delimited JSON protocol has `probe`, `launch`, and
`terminate` methods. It is stdio only, has no listening socket, includes a
protocol version, and returns an explicit policy denial, containment failure,
or process outcome. The TypeScript client respawns a failed broker once for a
new request and treats a failed broker during an active containment attempt as
a denial.

## Enforcement

The first native boundary enforces tree termination, explicit environments,
executable/cwd/root validation, WSL denial, and containment readiness. Network
deny is supported only when a provisioned WFP capability is available; it is
otherwise rejected. Writable roots require native capability/ACL enforcement;
requests requiring writable roots are rejected until that capability is ready.
This is fail-closed, not degraded execution.

The TypeScript `NativeSupervisor` owns lazy broker startup. It probes once before
the first contained launch, verifies the profile's required capabilities, and
closes and recreates the broker after a disconnect. Core constructs this service
without spawning a broker at application startup; unconfined planning remains
pure and unchanged. The broker currently reports only Job Object, explicit
environment, and restricted-token enforcement. Writable-root ACL enforcement
and WFP network denial are intentionally not reported and remain blocked until
they can be implemented and tested safely on Windows.

## Tests

TypeScript tests cover request conversion, environment stripping, WSL and
network-denial behavior, and broker failure. Windows-only Rust integration
tests exercise real child/grandchild termination, forbidden root rejection,
environment stripping, and unavailable-containment failure. Tests skip on
non-Windows hosts and never claim enforcement there.
