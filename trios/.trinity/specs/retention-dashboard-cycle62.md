# Retention Dashboard — Cycle 62

**Issue:** browseros-ai/BrowserOS#2053 (continuation)
**Ring:** BR-OUTPUT / LogsTabView.swift, SR-02 / LogParser.swift
**Road:** B (fix + test + experience save)

## Problem

Cycle 61 gave users editable overrides for the four `LogRotationPolicy` presets, but the sheet is a blind form. After editing a value the user cannot see:

1. The *effective* merged policy (hard-coded default + override).
2. The disk space currently used by active files and archives for each policy family.
3. When the next rotation is likely to occur.
4. The impact of worktree audit streams.

Without this feedback, retention tuning is guesswork.

## Goal

Extend `LogRetentionSettingsSheet` with a read-only **Retention Dashboard** summary at the top that shows, for each policy family (`audit`, `security`, `experience`, `default`):

- Effective max file size, archive count, archive age, rotate-after age.
- Current active-file size and archive count/size.
- Next-rotation estimate (closest of size-based and age-based triggers).
- A usage bar relative to the effective max size.

Also add:

- A **"Rotate now"** button that calls `LogRotationPolicy.rotateAuditLogs()` and refreshes the dashboard.
- A **total footprint** line at the bottom.
- Worktree-aware archive counting where applicable.

## Non-goals

- Do not change persistence format; reuse existing `LogRetentionSettings`.
- Do not add new retention knobs; only surface existing ones.
- Do not build charts or external dependencies; use simple SwiftUI bars and labels.

## Competitor patterns

- **Datadog Log Archives** — shows storage used per archive, last archive time, next scheduled archive, and a bar chart.
- **Splunk Index Detail** — current index size vs. max size, bucket count, earliest/latest event.
- **Elasticsearch ILM** — phase timings, index size, shard count, simulated transition timeline.
- **macOS Console / logd** — total log size with compress/recover estimate.
- **iOS Settings → iPhone Storage** — per-app bar charts and last-used labels.

The common pattern: show **effective policy**, **current usage**, and **predicted next action** in one view.

## Design

### 1. Model additions in `rings/SR-02/LogParser.swift`

Add a value type that can be produced from a policy family and a set of paths:

```swift
struct LogRetentionSnapshot: Sendable {
    let policyName: String
    let effectivePolicy: LogRotationPolicy
    let activePaths: [(path: String, size: UInt64)]
    let archives: [(path: String, size: UInt64, timestamp: TimeInterval)]
    let totalActiveBytes: UInt64
    let totalArchiveBytes: UInt64
    let nextRotationEstimate: NextRotationEstimate
}

enum NextRotationEstimate: Sendable {
    case none
    case size(currentBytes: UInt64, thresholdBytes: UInt64)
    case age(currentAge: TimeInterval, thresholdAge: TimeInterval)
    case imminent(reason: String)
}
```

Add a static helper on `LogRotationPolicy`:

```swift
static func snapshot(for name: String, paths: [String]) -> LogRetentionSnapshot
```

For the four known families, provide a convenience:

```swift
static func auditLogPaths() -> [String]
static func securityLogPaths() -> [String]
static func experienceLogPaths() -> [String]
static func defaultLogPaths() -> [String]
```

### 2. UI additions in `BR-OUTPUT/LogsTabView.swift`

At the top of `LogRetentionSettingsSheet`, before the editable sections, add a `RetentionDashboardPanel`:

- Header: "Current retention state".
- For each policy name in `["audit", "security", "experience", "default"]`:
  - Label row: "Audit — 2.4 MB active / 6.1 MB archives".
  - Bar: width = `totalActiveBytes + totalArchiveBytes` relative to a sensible max (e.g. `effectivePolicy.maxFileSizeBytes * max(1, effectivePolicy.maxArchiveCount)`).
  - Detail row: "Effective: 1 MB × 5 archives, 30d / 1d. Next rotation: ~12h (size 84%)."
- Footer row: "Total log/audit footprint: X MB across Y files."
- Buttons: "Rotate now" (calls `LogRotationPolicy.rotateAuditLogs()` and refreshes) and "Refresh" (recomputes snapshots).

### 3. Tests

- `testRetentionSnapshotIncludesActiveSizeAndArchives`
- `testRetentionSnapshotNextRotationByAge`
- `testRetentionSnapshotNextRotationBySize`
- `testRetentionSnapshotWorktreeArchivesIncluded`
- `testDashboardViewModelRefresh` (if a lightweight view model is added)

## Files

- `trios/rings/SR-02/LogParser.swift` — `LogRetentionSnapshot`, path enumeration, snapshot builder.
- `trios/BR-OUTPUT/LogsTabView.swift` — `RetentionDashboardPanel`, integrate into `LogRetentionSettingsSheet`.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` — snapshot unit tests.

## TDD

- `./build.sh` passes.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` passes with 0 hard-gate findings.
- `cargo run --bin clade-e2e` passes (or fails only on the host Xcode-license blocker, with manual logic-test confirmation).
- New XCTest cases pass (syntactically validated by build if XCTest unavailable).
- `open trios.app` relaunches and health returns ok; menu-bar logo preserved.

## Three variants

1. **Variant A — Dashboard panel inside the existing retention sheet** (recommended): minimal new chrome, surfaces effective values and usage, adds "Rotate now". Low risk.
2. **Variant B — Standalone LOGS tab footer panel**: a non-modal summary bar under the source list showing total footprint and next rotation. Always visible but more intrusive.
3. **Variant C — CLI/report-only dashboard**: add a `cargo run --bin clade-retention-report` command that prints markdown. Useful for headless/WSL but does not help the macOS GUI user.
