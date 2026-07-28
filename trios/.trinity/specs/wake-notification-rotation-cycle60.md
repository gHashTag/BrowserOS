# Wake-Notification Audit Rotation Re-run — Cycle 60

**Issue:** browseros-ai/BrowserOS#2052
**Ring:** SR-02 / LogParser.swift
**Road:** B (fix + test + experience save)

## Problem

`AuditRotationScheduler` in `rings/SR-02/LogParser.swift` uses a 6-hour repeating `Timer` to call `LogRotationPolicy.rotateAuditLogs()`. `Timer` is paused while the Mac sleeps. If a machine sleeps for 8-12 hours (common on laptops), the scheduled rotation is effectively skipped and the next fire may be hours away. Long-running trios processes that wake from sleep can therefore go long stretches without rotating `event_log.jsonl`, `akashic-log.jsonl`, `local-auth-audit.jsonl`, and `episodes.jsonl`, undoing the protection added in Cycles 56-59.

## Goal

Re-run audit rotation promptly after the Mac wakes from sleep whenever enough wall-clock time has elapsed that the scheduled 6-hour rotation would likely have fired.

## Non-goals

- Do not change the 6-hour timer interval.
- Do not change the rotation policies.
- Do not add a UI control for wake behavior in this cycle.

## Competitor patterns

- **macOS system daemons / logd** — subscribe to `NSWorkspace.didWakeNotification` to refresh caches and run housekeeping after sleep.
- **systemd timers (Linux)** — `Persistent=true` catches up missed timers after wake/hibernation.
- **launchd `StartCalendarInterval`** — runs missed jobs shortly after the system wakes.
- **Datadog Agent / Fluent Bit** — use OS power/wake events to re-run collectors and log housekeeping.
- **Logrotate (cron)** — relies on the next wall-clock cron run to catch up, which is acceptable for server uptime but not for a laptop app that may sleep for days.

The common pattern for desktop agents is: react to the OS wake event and re-run periodic housekeeping if the timer drifted during sleep.

## Design

Extend `AuditRotationScheduler` to observe `NSWorkspace.didWakeNotification`.

- Track `lastRotationDate`.
- On wake, compare wall-clock time since `lastRotationDate`. If more than `interval / 2` has elapsed (or no rotation has ever been recorded), call `rotateNow()`.
- Update `lastRotationDate` when rotation is dispatched to prevent duplicate wake-triggered runs.
- Remove the observer in `stop()`.
- Add a testable `dateProvider` initializer parameter so tests can control the clock without real sleeps.

## Files

- `trios/rings/SR-02/LogParser.swift` — extend `AuditRotationScheduler` with wake observer and overdue-rotation logic.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` — add tests for wake observer registration, overdue rotation, and suppression of duplicate wake runs.

## TDD

- `./build.sh` passes.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` passes with 0 hard-gate findings.
- `cargo run --bin clade-e2e` passes.
- `open trios.app` relaunches and health returns ok; menu-bar logo preserved.

## Three variants

1. **Variant A (implemented)** — `NSWorkspace.didWakeNotification` observer with `interval/2` threshold and `lastRotationDate` tracking.
2. **Variant B — shorter timer + drift detection**: keep a 1-hour timer and compare `Date()` against the last scheduled fire; fire on wake if drift is large. More complex because `Timer` itself pauses.
3. **Variant C — persisted next-due flag**: write a `next_rotation_due` timestamp to disk and check it on every app foreground/background transition. Heavier persistence surface for marginal gain.
