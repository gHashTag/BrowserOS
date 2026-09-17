# Cycle 48 Plan — LOGS tab noise suppression + reader-side log rotation

## Problem
Trios logs contain a lot of repetitive, low-signal noise (`watchdog_heartbeat`, `drift_detected`, `Reclaiming stale task leases`) and watched log files can grow unbounded because there is no rotation policy.

## Chosen variant (Road B)
Add a client-side noise filter and UI toggle, plus a reader-side rotation policy that runs when the LOGS tab loads. This is a bounded, testable change that gives immediate relief without re-architecting server logging.

## Decomposition
1. **Research & cleanup** — measure garbage composition, delete stale logs, rotate the active companion log safely.
2. **Noise model** — add `LogNoiseFilter` with hard-coded high-signal patterns derived from the measurement.
3. **UI toggle** — add `suppressNoise` state and a **Quiet** toggle in `LogsTabView`, default on.
4. **Rotation policy** — add `LogRotationPolicy` with size threshold, tail retention, compressed archives, archive retention, and `lsof` external-writer guard.
5. **Wiring** — call rotation for canonical logs and all `.trinity/logs/*.log` files inside `LogParser.loadLogSources()`.
6. **Tests** — unit tests for noise filter, toggle, `unifiedLines` noise flag, rotation truncation, and archive cleanup.
7. **Verification** — `./build.sh`, `clade-build`, `clade-audit`, `clade-seal`, `clade-e2e`, `cargo test -p trios-mesh`, relaunch app.

## Files
- `trios/rings/SR-02/LogParser.swift`
- `trios/BR-OUTPUT/LogsTabView.swift`
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift`

## Acceptance criteria
- Build passes with 0 errors.
- clade-audit and clade-seal pass.
- New tests compile (swift test unavailable in this environment).
- Menu-bar logo is preserved after relaunch.
