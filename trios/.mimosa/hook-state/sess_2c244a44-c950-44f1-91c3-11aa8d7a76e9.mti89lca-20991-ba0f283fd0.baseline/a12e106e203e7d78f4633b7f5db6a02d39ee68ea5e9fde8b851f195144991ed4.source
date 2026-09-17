# Cycle 62 Plan — Retention Dashboard

## Weak spot

Cycle 61 made retention policies editable, but the settings sheet gives no feedback: users cannot see the *effective* merged values, current disk usage per policy family, or when the next rotation will happen.

## Competitor insight

- Datadog Log Archives surfaces storage used, last archive time, and next scheduled archive.
- Splunk Index Detail shows current/max size, bucket count, and bucket age.
- Elasticsearch ILM shows phase timings and index size.
- macOS Console shows total log size and a compress/recover estimate.
- iOS Settings Storage shows per-app bar charts and last-used labels.
- Common pattern: **effective policy + current usage + predicted next action** in one view.

## Decomposition

1. **Spec** — write `.trinity/specs/retention-dashboard-cycle62.md`.
2. **Canon code (SR-02)** — delegate to t27-creator.
   - Add `LogRetentionSnapshot` value type and `NextRotationEstimate` enum.
   - Add static helpers to list paths belonging to each policy family (main repo + worktrees).
   - Add `LogRotationPolicy.snapshot(for:paths:)` that computes effective policy, active size, archive size/count, and next-rotation estimate.
3. **Canon code (BR-OUTPUT)** — delegate to t27-creator.
   - Add `RetentionDashboardPanel` at the top of `LogRetentionSettingsSheet`.
   - Show per-policy effective values, active/archive sizes, a usage bar, next-rotation estimate.
   - Add "Rotate now" button that calls `LogRotationPolicy.rotateAuditLogs()` and refreshes.
   - Add "Refresh" button to recompute snapshots.
4. **Tests** — add XCTest cases for snapshot computation, next-rotation estimates, worktree inclusion, and refresh semantics.
5. **Verify** — `./build.sh`, `clade-audit`, `clade-e2e`, relaunch app, health check.
6. **Report + learn** — write report, update `experience.md`, create episode JSON.

## Three variants

- **A — Dashboard panel inside the existing retention sheet** (chosen): low risk, low chrome, surfaces the data users need before they edit values.
- **B — Standalone LOGS tab footer panel**: always visible but more intrusive and competes for space with the log table.
- **C — CLI/report-only dashboard**: useful for headless/WSL, but the Cycle 62 request is GUI-focused.
