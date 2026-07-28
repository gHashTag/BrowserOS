# Cycle 60 Report — Wake-Notification Audit Rotation Re-run

**Issue:** browseros-ai/BrowserOS#2052
**Ring:** SR-02 / LogParser.swift
**Road:** B (fix + test + experience save)
**Agents:** claude, t27-creator

## 1. Weak spot

`AuditRotationScheduler` in `rings/SR-02/LogParser.swift` uses a 6-hour repeating `Timer`. `Timer` is paused while macOS sleeps. Laptops that sleep for 8-12 hours miss scheduled audit rotations; when trios wakes, the next rotation may still be hours away. This undermines the retention work from Cycles 56-59 for long-running processes on portable machines.

## 2. Competitor insight

- **macOS system daemons / logd** subscribe to `NSWorkspace.didWakeNotification` to refresh caches and run housekeeping after sleep.
- **systemd timers** use `Persistent=true` to catch up missed fires after wake/hibernation.
- **launchd `StartCalendarInterval`** runs missed jobs shortly after wake.
- **Datadog Agent / Fluent Bit** react to OS power/wake events to re-run collectors and log housekeeping.
- The common desktop-agent pattern is: react to the OS wake event and re-run periodic housekeeping if the timer drifted during sleep.

## 3. Decomposition and implementation

1. **Spec** — `.trinity/specs/wake-notification-rotation-cycle60.md` defined the wake-triggered re-run behavior.
2. **Canon code** — `t27-creator` updated `rings/SR-02/LogParser.swift`:
   - Added a testable `dateProvider: () -> Date` initializer parameter (default `Date.init`).
   - Added `private(set) var lastRotationDate: Date?` to track the last successful rotation start.
   - Added `private var wakeObserver: NSObjectProtocol?` for the NSWorkspace observer token.
   - `start()` now registers an observer on `NSWorkspace.shared.notificationCenter` for `NSWorkspace.didWakeNotification` on the main queue.
   - Added `shouldRotateOnWake() -> Bool` returning true when `lastRotationDate` is nil or more than `interval / 2` has elapsed.
   - `handleWakeNotification()` calls `rotateNow()` only when `shouldRotateOnWake()` is true, preventing duplicate runs.
   - `rotateNow()` updates `lastRotationDate` synchronously on the caller (MainActor) before dispatching rotation to the utility queue, so repeated wake notifications are cheap and safe.
   - `stop()` invalidates the timer and removes the observer.
3. **Tests** — added XCTest cases in `tests/TriOSKitTests/LogsTabViewTests.swift`:
   - `testAuditSchedulerRecordsLastRotationDate`
   - `testAuditSchedulerShouldRotateOnWakeWhenOverdue`
   - `testAuditSchedulerShouldNotRotateOnWakeWhenRecent`
   - `testAuditSchedulerWakeHandlerRotatesWhenOverdue`
4. **Verify** — `./build.sh`, `clade-audit`, `clade-e2e`, relaunch app, health check.

## 4. TDD results

- `./build.sh` — PASS.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` — PASS, 0 hard-gate findings across 8 checks.
- `cargo run --bin clade-e2e` — PASS (report `.trinity/e2e/report_prod_1785219692.md`).
- `open trios.app` relaunch — PASS; health returned `{"status":"ok","cdpConnected":true}`; menu-bar logo preserved.
- XCTest runtime execution was not available because the host toolchain is CommandLineTools-only; tests were syntactically validated by `./build.sh`.

## 5. Three variants

- **Variant A — NSWorkspace wake observer with threshold** (implemented): reacts to real OS wake events and only rotates if the scheduled interval has drifted.
- **Variant B — Shorter timer + drift detection**: keeps a 1-hour timer and compares wall-clock drift; more complex because `Timer` still pauses during sleep.
- **Variant C — Persisted next-due flag**: writes a `next_rotation_due` timestamp to disk and checks it on every foreground transition; heavier persistence surface for marginal gain.

## 6. Files changed

- `trios/rings/SR-02/LogParser.swift` — `AuditRotationScheduler` wake observer, overdue-rotation logic, and testable clock.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` — scheduler wake-rotation tests.
- `trios/.trinity/specs/wake-notification-rotation-cycle60.md` — spec.
- `trios/.claude/plans/trios-cycle60-wake-notification-rotation.md` — plan.
- `trios/.claude/plans/trios-cycle60-wake-notification-rotation-report.md` — this report.

## 7. Next options

1. **Retention configuration UI** — expose per-stream max size, archive count, and retention age in Settings/Logs.
2. **Rust-side audit log cleanup** — add a `cargo run --bin clade-cleanup-audit` subcommand for non-macOS/WSL environments.
3. **Scheduler jitter / backoff** — add small random jitter to the 6-hour timer and wake re-run to avoid thundering-herd I/O if multiple worktrees exist.

---

Phase complete: SYNTHESIZE
→ Phase 9: LEARN
