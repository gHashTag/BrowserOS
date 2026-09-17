# Cycle 56 - JSONL audit stream rotation and age-based retention

## Problem

Cycles 54-55 capped and aged build/test artifact logs, but the audit/JSONL streams remain unbounded:

- `.trinity/events/akashic-log.jsonl` (112K) — audit/claims/Akashic events
- `.trinity/state/local-auth-audit.jsonl` (51K) — security/auth audit
- `.trinity/experience/episodes.jsonl` (11K) — learning episodes
- `.trinity/event_log.jsonl` (48K) + `.trinity/event_log.jsonl.archive.*.gz/.zlib` (33K) — general queen/cron events
- Legacy `.archive.*` files for `cron.stderr.log` (35K) sitting outside the new retention policy.

`LogRotationPolicy` in `rings/SR-02/LogParser.swift` already rotates `.log` files watched by the LOGS tab, but it only triggers on size (>1MB) and only keeps 5 archives with no age-based eviction. The JSONL audit streams are not covered, and the policy has no daily/age trigger.

## Competitor patterns

- **systemd-journald:** `SystemMaxUse`, `MaxRetentionSec`, `journalctl --vacuum-time=30d`.
- **auditd:** `max_log_file` + `num_logs` size/count rotation.
- **Splunk:** `maxTotalDataSizeMB` + `frozenTimePeriodInSecs` (size + age).
- **Elasticsearch ILM:** rollover by size/age, then delete after retention period.
- **Datadog / CloudTrail:** archive to cold storage then expire after compliance period.
- **Fluent Bit:** `storage.total_limit_size` drops oldest chunks when full.

Consensus best practice for a small local app: **size trigger + count cap + age eviction**, compress archives, keep a small tail in the active file, and do not auto-delete security audit streams quickly.

## Root cause

`LogRotationPolicy` is wired only inside `LogParser.loadLogSources()` and only for files the LOGS tab loads. Audit JSONL streams (`akashic-log.jsonl`, `local-auth-audit.jsonl`, `episodes.jsonl`) are not loaded by the LOGS tab, so they never rotate. The existing policy has no `maxArchiveAge`, so archives accumulate forever.

## Goal

1. Extend `LogRotationPolicy` with age-based retention for archives.
2. Add daily/age trigger so files rotate at least every N days even if small.
3. Rotate all known JSONL audit streams on app launch and when the LOGS tab loads.
4. Keep security audit (`local-auth-audit.jsonl`) with a longer retention.
5. Add unit tests.

## Variants

### Variant A — Chosen: extend existing `LogRotationPolicy` and add `rotateAuditLogs()`
- Add `maxArchiveAgeSeconds` and `maxAgeBeforeRotationSeconds` to `LogRotationPolicy`.
- Add per-stream static policies (`audit`, `security`, `experience`).
- Add `LogRotationPolicy.rotateAuditLogs()` covering `event_log.jsonl`, `akashic-log.jsonl`, `local-auth-audit.jsonl`, `episodes.jsonl`.
- Call `rotateAuditLogs()` in `AppDelegate.applicationDidFinishLaunching()` and `LogParser.loadLogSources()`.
- Add XCTest coverage for age eviction, archive cleanup, and `lsof` guard.
- **Pros:** minimal new code, reuses existing zlib compression and `lsof` guard, no new files/processes.
- **Cons:** rotation only runs when app launches or LOGS tab opens; long-running app without LOGS open may lag.

### Variant B — background rotation service
- Create a new `AuditLogRotationService` actor with a `Timer`/ `Task.sleep` loop that runs every 6-24h.
- Registers all audit paths on init and rotates on a schedule.
- **Pros:** proactive, works regardless of UI usage.
- **Cons:** more code, new lifecycle dependency, risk of timer leak across app sleeps, requires actor scheduling tests.

### Variant C — Rust `clade-cleanup-logs` subcommand
- Port the cleanup logic to a Rust binary that scans all JSONL streams and deletes old archives.
- Call it from `build.sh` and add a cron skill to run periodically.
- **Pros:** cross-platform, runs outside the app, can cover worktrees.
- **Cons:** duplicates Swift logic, slower to implement, no `lsof` awareness for live files, overkill for local JSONL streams.

## Chosen solution

**Variant A** — extend the existing `LogRotationPolicy` and add `rotateAuditLogs()`. It is the smallest, safest increment and directly closes the gap identified in Cycles 54-55.

## Scope

- `trios/rings/SR-02/LogParser.swift`
  - Extend `LogRotationPolicy` with `maxArchiveAgeSeconds` and `maxAgeBeforeRotationSeconds`.
  - Add `cleanupOldArchives(path:)`.
  - Add `rotateAuditLogs()`.
  - Call `rotateAuditLogs()` from `loadLogSources()`.
- `trios/main.swift`
  - Call `LogRotationPolicy.rotateAuditLogs()` in `applicationDidFinishLaunching`.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift`
  - Add tests for age-based archive eviction and audit stream rotation.
- `trios/.trinity/specs/audit-log-rotation-cycle56.md` (new)
- `trios/.claude/plans/trios-cycle56-audit-log-rotation-report.md` (new)
- `trios/.trinity/experience/2026-07-28_audit-log-rotation-cycle56-loop-056.json` (new)

## Non-scope

- No changes to artifact log cleanup (Cycle 55).
- No changes to noise profiles / LOGS tab UI.
- No remote/cloud archive tiers.
- No UI for configuring retention knobs.

## Acceptance criteria

- `LogRotationPolicy` deletes archives older than `maxArchiveAgeSeconds`.
- `LogRotationPolicy` rotates active files older than `maxAgeBeforeRotationSeconds` even if below size limit.
- All four audit JSONL streams are rotated on app launch.
- `./build.sh` passes.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` passes with 0 findings.
- `cargo run --bin clade-e2e` passes.
- `open trios.app` relaunches and health returns `{"status":"ok"}`; menu-bar logo stays visible.

## TDD

- Unit test: create a JSONL file + old archives, apply policy, assert old archives deleted and active file archived.
- Unit test: create a JSONL file older than rotation age but under size, apply policy, assert archived and truncated.
- Unit test: simulate external writer via stub or by passing a path with a fake `lsof` guard, assert no truncation.
- Build/e2e/audit gates as above.
