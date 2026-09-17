# Cycle 57 Plan — Background Audit Rotation Scheduler

## Weak spot

JSONL audit streams only rotate on app launch or LOGS-tab open. Long-running trios processes can grow audit files for days.

## Competitor insight

systemd-journald, logrotate, Datadog Agent, Splunk, Fluent Bit, and macOS Unified Logging all run background rotation on a schedule. Time-based rotation is the norm; size-only or launch-only rotation is the gap.

## Decomposition

1. **Spec** — write `.trinity/specs/background-audit-rotation-cycle57.md`.
2. **Canon code** — delegate `rings/SR-02/LogParser.swift` changes to t27-creator (add `AuditRotationScheduler`).
3. **Wiring** — manually edit `main.swift` under existing Agent-V waiver to start/stop the scheduler.
4. **Tests** — add XCTest cases in `LogsTabViewTests.swift`.
5. **Verify** — `./build.sh`, `clade-audit`, `clade-e2e`, relaunch app, health check.
6. **Report + learn** — write report and episode, update `experience.md`.

## Three variants

- **A — Timer + utility queue** (chosen): Foundation `Timer`, utility queue rotation, `NSLock` serialization.
- **B — Swift concurrency sleep loop**: actor-owned `Task.sleep` loop; cleaner cancellation but less RunLoop integration.
- **C — Rust clade-monitor subcommand**: external rotation, covers worktrees/headless, but duplicates policy logic.
