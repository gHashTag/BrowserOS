# Background Audit Rotation Scheduler — Cycle 57

**Issue:** browseros-ai/BrowserOS#2049
**Ring:** SR-02 / main.swift
**Road:** B (fix + test + experience save)

## Problem

Cycle 56 made JSONL audit streams rotate, but `LogRotationPolicy.rotateAuditLogs()` only runs:

1. Once in `AppDelegate.applicationDidFinishLaunching()`.
2. Whenever `LogParser.loadLogSources()` is called (the LOGS tab opens).

For a long-running trios process the audit files can still grow unbounded for days or weeks until the user opens the LOGS tab or restarts the app. `akashic-log.jsonl` is already 176 KB on a dev machine after a few days.

## Goal

Add a lightweight background scheduler that re-runs audit log rotation on a fixed interval while trios is running, without blocking the main thread or UI.

## Non-goals

- Do not add a retention settings UI in this cycle (that is a later option).
- Do not rotate worktree audit streams in this cycle (also a later option).
- Do not change archive compression format or archive naming.

## Competitor patterns

- **systemd-journald** — `MaxFileSec=1day` plus `MaxRetentionSec=1month`: time-based rotation is the default, not size-only.
- **logrotate** — cron-driven `daily`/`weekly` with `rotate N` and `maxage`: scheduled rotation is the standard Unix pattern.
- **Datadog Agent** — `max_file_size` + `max_files` + `expiration_date`: background daemon rotates logs while the process runs.
- **Splunk** — `frozenTimePeriodInSecs` rolls buckets by age; indexers run rotation continuously.
- **Fluent Bit** — `storage.total_limit_size` and `rotate_wait` cap and rotate buffers in the background agent.
- **macOS Unified Logging** — compressed and TTL-evicted by the logging daemon without app involvement.

The common pattern is: a background agent rotates logs by a schedule, not only on launch.

## Design

Add an `AuditRotationScheduler` singleton actor that:

- Schedules a repeating `Timer` on the main RunLoop (default 6 hours, configurable for tests).
- Runs `LogRotationPolicy.rotateAuditLogs()` on a `DispatchQueue.global(qos: .utility)` queue so file I/O does not stall the UI.
- Uses an `NSLock` to serialize rotations and avoid overlapping runs if a manual trigger coincides with the timer.
- Provides `start()` / `stop()` lifecycle methods called from `AppDelegate.applicationDidFinishLaunching()` and `applicationWillTerminate()`.
- Provides `rotateNow()` for manual/cron use and tests.

## Files

- `trios/rings/SR-02/LogParser.swift` — add `AuditRotationScheduler`.
- `trios/main.swift` — start/stop the scheduler in `AppDelegate`.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` — add scheduler lifecycle and serialization tests.

## TDD

- `./build.sh` passes.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` passes with 0 hard-gate findings.
- `cargo run --bin clade-e2e` passes.
- New XCTest passes: scheduler starts/stops, `rotateNow()` runs without crash, concurrent `rotateNow()` calls are serialized.
- `open trios.app` relaunches and health returns ok; menu-bar logo is preserved.

## Three variants

1. **Variant A (Timer + utility queue)** — implemented. Reuses Foundation `Timer`, runs on global queue. Low risk, app-contained, easy to test.
2. **Variant B (Swift concurrency sleep loop)** — an actor owns a `Task { while !isCancelled { rotate(); try await Task.sleep(...) } }`. Cleaner cancellation, but less integrated with the main RunLoop and harder to align with app lifecycle.
3. **Variant C (Rust clade-monitor cron job)** — add a `clade-audit-rotate` Rust subcommand that replicates the policy externally, covers worktrees and headless machines, but duplicates logic and requires keeping Swift and Rust policies in sync.
