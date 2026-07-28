# Retention Settings UI — Cycle 61

**Issue:** browseros-ai/BrowserOS#2053
**Ring:** BR-OUTPUT / LogsTabView.swift, SR-02 / LogParser.swift
**Road:** B (fix + test + experience save)

## Problem

Cycles 54-60 hard-coded log/audit retention policies (`LogRotationPolicy.default`, `.audit`, `.security`, `.experience`) in `rings/SR-02/LogParser.swift`. Users cannot adjust:

- Max file size before rotation.
- Number of archives to keep.
- Max archive age before eviction.
- Age before forced rotation.

Power users on long-running dev machines may need different caps than the defaults (e.g. larger `experience` archives, shorter security retention). There is no way to tune these without editing source code.

## Goal

Add a "Retention" section to the LOGS tab (or a standalone sheet reachable from it) that exposes user-editable overrides for the four static `LogRotationPolicy` presets. Overrides are persisted to `UserDefaults` and are honored by `LogRotationPolicy.rotateAuditLogs()` and `LogParser.loadLogSources()`.

## Non-goals

- Do not expose per-file overrides in this cycle.
- Do not change the default values; they remain the shipped constants.
- Do not add new retention knobs beyond the four existing numeric fields.

## Competitor patterns

- **Datadog Agent** — provides a "Log Archives" settings pane with retention days and max archive size.
- **Splunk** — Index Settings expose max index size, max hot/warm bucket age, and frozen archive policy.
- **Elasticsearch ILM** — UI exposes hot/warm/cold/delete phases with age and size triggers.
- **journald.conf** — text-based retention config (`SystemMaxUse=`, `MaxFileSec=`, `MaxRetentionSec=`).
- **logrotate** — config file per-log policy (`size`, `rotate`, `maxage`).

The common pattern is: expose the same four knobs (size, count, age, forced-rotation age) per policy family in a settings view, persist to a user-editable store, and fall back to defaults when no override exists.

## Design

1. Add `LogRetentionSettings` model in `rings/SR-02/LogParser.swift`:
   - Codable struct keyed by policy name (`default`, `audit`, `security`, `experience`).
   - Each entry stores optional `maxFileSizeBytes`, `maxArchiveCount`, `maxArchiveAgeSeconds`, `maxAgeBeforeRotationSeconds`.
   - Default provider: `UserDefaults.standard`, key `trios_log_retention_settings`.
   - `policy(named:default:)` merges user overrides over the hard-coded default.

2. Replace static `LogRotationPolicy.audit/security/experience/default` resolution with static computed-like access:
   - Keep the hard-coded constants as `LogRotationPolicy.defaultPolicy` etc.
   - Add `static func effectivePolicy(for name: String) -> LogRotationPolicy` that reads `LogRetentionSettings.shared`.

3. Update call sites:
   - `LogRotationPolicy.audit` → `LogRotationPolicy.effectivePolicy(for: "audit")`.
   - `LogRotationPolicy.security` → `LogRotationPolicy.effectivePolicy(for: "security")`.
   - `LogRotationPolicy.experience` → `LogRotationPolicy.effectivePolicy(for: "experience")`.
   - `.default` keep unchanged for non-audit log files.

4. Add `LogRetentionSettingsSheet` in `BR-OUTPUT/LogsTabView.swift`:
   - Reachable via a gear icon in the LOGS tab header.
   - Form with four sections (Audit, Security, Experience, General/Default).
   - Each section has size (MB), archive count, archive age (days), and forced-rotation age (days) text fields.
   - "Reset to defaults" button.
   - Persist on sheet dismiss or value change.

5. Add `LogRetentionSettings` unit tests in `tests/TriOSKitTests/LogsTabViewTests.swift`:
   - Override round-trip.
   - Default fallback for missing keys.
   - Invalid values ignored.
   - Effective policy merge order.

## Files

- `trios/rings/SR-02/LogParser.swift` — add `LogRetentionSettings`, `effectivePolicy(for:)`, update policy call sites.
- `trios/BR-OUTPUT/LogsTabView.swift` — add `LogRetentionSettingsSheet` and gear button.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` — retention settings tests.

## TDD

- `./build.sh` passes.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` passes with 0 hard-gate findings.
- `cargo run --bin clade-e2e` passes.
- New XCTest cases pass (syntactically validated by build if XCTest unavailable).
- `open trios.app` relaunches and health returns ok; menu-bar logo preserved.

## Three variants

1. **Variant A — Per-policy overrides in LOGS tab sheet** (implemented). User edits the four numeric fields per preset; overrides merge with hard-coded defaults.
2. **Variant B — JSON text editor**: expose a text area where users edit raw `trios_log_retention_settings` JSON. Flexible but unfriendly.
3. **Variant C — Per-file rules**: allow users to add custom retention rules for individual log files. Powerful but much larger surface and validation burden.
