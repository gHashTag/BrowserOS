# Cycle 57 Report — Background Audit Rotation Scheduler

## Weak spot addressed

Cycle 56 added time-based rotation for JSONL audit streams, but the rotation only ran on app launch and when the LOGS tab opened. A long-running trios process could let `event_log.jsonl`, `akashic-log.jsonl`, `local-auth-audit.jsonl`, and `episodes.jsonl` grow for days or weeks.

## Competitor patterns

- **systemd-journald** — `MaxFileSec=1day` and `MaxRetentionSec=1month` make scheduled rotation the default, not launch-only.
- **logrotate** — cron-driven `daily`/`weekly` with `rotate N` and `maxage` is the standard Unix retention model.
- **Datadog Agent** — `max_file_size`, `max_files`, and `expiration_date` rotate logs in the background daemon.
- **Splunk** — `frozenTimePeriodInSecs` rolls buckets by age in a continuously running indexer.
- **Fluent Bit** — `storage.total_limit_size` and `rotate_wait` cap buffers and rotate in the background.
- **macOS Unified Logging** — compressed and TTL-evicted by the logging subsystem without app involvement.

The common pattern is a background agent that rotates on a schedule.

## Implementation

- Added `AuditRotationScheduler` in `rings/SR-02/LogParser.swift`.
  - `@MainActor` singleton with configurable `init(interval:)`.
  - Repeating `Timer` (default 6 hours) using `[weak self]`.
  - Each fire dispatches `LogRotationPolicy.rotateAuditLogs()` to `DispatchQueue.global(qos: .utility).async` and serializes with an `NSLock`.
  - `start()` / `stop()` lifecycle plus `rotateNow()` for manual/cron/test use.
- Wired `AuditRotationScheduler.shared.start()` in `main.swift` after the synchronous launch-time rotation.
- Wired `AuditRotationScheduler.shared.stop()` in `main.swift` `applicationWillTerminate(_:)`.
- Added XCTest cases in `tests/TriOSKitTests/LogsTabViewTests.swift` for start/stop lifecycle and repeated `rotateNow()` calls.

## Verification

- `./build.sh` (with `TRIOS_SKIP_CHAT_E2E=1`) — PASS, app bundle signed.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` — PASS, 0 hard-gate findings across 8 checks.
- `cargo run --bin clade-e2e` — PASS, report `.trinity/e2e/report_prod_1785215729.md`.
- `open trios.app` relaunched; health returned `{"status":"ok","cdpConnected":true}`; menu-bar logo preserved.
- Note: XCTest could not be executed in this toolchain because XCTest is not available in the CommandLineTools-only install, but the new tests compile syntactically with the rest of the target.

## Three variants

1. **Variant A — Timer + utility queue** (chosen and landed). Reuses Foundation `Timer`, runs rotation off the main thread, low risk, no Rust changes.
2. **Variant B — Swift concurrency sleep loop**. An actor owns `Task { while !isCancelled { rotate(); try await Task.sleep(...) } }`. Cleaner cancellation, but less RunLoop-aligned and harder to align with app lifecycle.
3. **Variant C — Rust clade-monitor subcommand**. Add `clade-audit-rotate` in Rust that replicates the policy externally, covering worktrees and headless machines, but duplicates policy logic and requires keeping Swift and Rust retention rules in sync.

## Files

- `trios/rings/SR-02/LogParser.swift`
- `trios/main.swift`
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift`
- `trios/.trinity/specs/background-audit-rotation-cycle57.md`
- `trios/.claude/plans/trios-cycle57-background-audit-rotation.md`
- `trios/.claude/plans/trios-cycle57-background-audit-rotation-report.md`
- `trios/.trinity/experience/2026-07-28_background-audit-rotation-cycle57-loop-057.json`

## Next options

1. **Worktree audit cleanup** — extend `rotateAuditLogs()` / `AuditRotationScheduler` to also rotate `.worktrees/*/trios/.trinity/*.jsonl` streams.
2. **Retention configuration UI** — expose per-stream max size, archive count, and retention age in Settings/Logs.
3. **Wake-notification re-run** — subscribe to `NSWorkspace.didWakeNotification` and re-run rotation after long sleeps.
