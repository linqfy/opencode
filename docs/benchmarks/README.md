# Benchmarks

`environment.json` (Stage 0) records the reference machine and toolchain. Runtime baselines — desktop cold/warm start, idle private working set, provider token counts, durability matrix results — are captured by the Stage 0A plan against signed Electron builds, and re-measured at every subsequent stage gate.

Acceptance KPIs are defined in spec section 16. A gate fails if its KPIs regress against the frozen baseline without a recorded, owner-approved exception.
