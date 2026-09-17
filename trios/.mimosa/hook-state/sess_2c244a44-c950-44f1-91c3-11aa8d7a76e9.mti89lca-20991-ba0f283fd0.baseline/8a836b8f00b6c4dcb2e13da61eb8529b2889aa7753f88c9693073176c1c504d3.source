# Cycle 60 Plan — Wake-Notification Audit Rotation Re-run

## Weak spot

`AuditRotationScheduler` relies on a 6-hour `Timer`. macOS pauses timers during sleep, so laptops that sleep for long periods miss scheduled audit rotations. When trios wakes, the next rotation may be hours away and audit logs can grow unchecked.

## Competitor insight

- macOS system daemons and `logd` subscribe to `NSWorkspace.didWakeNotification`.
- systemd timers use `Persistent=true` to catch up missed fires.
- launchd `StartCalendarInterval` runs missed jobs on wake.
- Datadog Agent / Fluent Bit react to power/wake events to re-run housekeeping.
- Desktop agents should react to OS wake events, not just timers.

## Decomposition

1. **Spec** — write `.trinity/specs/wake-notification-rotation-cycle60.md`.
2. **Canon code** — delegate `rings/SR-02/LogParser.swift` changes to t27-creator.
   - Add `lastRotationDate` and `dateProvider` test hook.
   - Register `NSWorkspace.didWakeNotification` observer in `start()`.
   - On wake, compare elapsed time since `lastRotationDate`; if overdue, call `rotateNow()`.
   - Update `lastRotationDate` in `rotateNow()` under the lock.
   - Remove observer in `stop()`.
3. **Tests** — add XCTest cases in `LogsTabViewTests.swift` for:
   - start registers wake observer (indirect via safe behavior)
   - overdue wake triggers rotation
   - recent wake does not trigger duplicate rotation
   - `lastRotationDate` is updated after `rotateNow()`
4. **Verify** — `./build.sh`, `clade-audit`, `clade-e2e`, relaunch app, health check.
5. **Report + learn** — write report, update `experience.md`, create episode JSON.

## Three variants

- **A — NSWorkspace wake observer with threshold** (chosen): clean, minimal, reacts to real OS event.
- **B — Shorter timer + drift detection**: reduces sleep drift but still timer-based and more complex.
- **C — Persisted next-due flag**: checks on foreground; heavier and not as responsive to wake.
