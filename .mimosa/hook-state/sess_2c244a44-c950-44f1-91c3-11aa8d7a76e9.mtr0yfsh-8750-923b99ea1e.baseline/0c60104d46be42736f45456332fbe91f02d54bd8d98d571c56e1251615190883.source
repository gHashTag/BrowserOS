# Cycle 61 Plan — Retention Settings UI

## Weak spot

`LogRotationPolicy` presets (`default`, `audit`, `security`, `experience`) are hard-coded in `rings/SR-02/LogParser.swift`. Users cannot tune max file size, archive count, archive age, or forced-rotation age without editing source.

## Competitor insight

- Datadog Agent exposes Log Archives settings (retention days, max archive size).
- Splunk Index Settings expose max index size, bucket age, frozen archive policy.
- Elasticsearch ILM UI exposes hot/warm/cold/delete phases with age and size triggers.
- journald.conf and logrotate use text-based per-policy retention config.
- The standard pattern: expose size/count/age/forced-rotation-age per policy family, persist user overrides, fall back to defaults.

## Decomposition

1. **Spec** — write `.trinity/specs/retention-settings-ui-cycle61.md`.
2. **Canon code (SR-02)** — delegate to t27-creator.
   - Add `LogRetentionSettings` model with `UserDefaults` persistence.
   - Add `LogRotationPolicy.effectivePolicy(for:)` that merges overrides on top of hard-coded constants.
   - Replace direct `.audit/.security/.experience` usage in `rotateAuditLogs()` and `loadLogSources()` with `effectivePolicy(for:)`.
3. **Canon code (BR-OUTPUT)** — delegate to t27-creator.
   - Add `LogRetentionSettingsSheet` reachable from LOGS tab header gear icon.
   - Four sections: Audit, Security, Experience, General/Default.
   - Numeric fields for size (MB), archive count, archive age (days), forced-rotation age (days).
   - Reset-to-defaults button.
4. **Tests** — add XCTest cases for settings round-trip, default fallback, invalid values, effective policy merge.
5. **Verify** — `./build.sh`, `clade-audit`, `clade-e2e`, relaunch app, health check.
6. **Report + learn** — write report, update `experience.md`, create episode JSON.

## Three variants

- **A — Per-policy overrides in LOGS tab sheet** (chosen): friendly UI, merges with defaults.
- **B — JSON text editor**: raw `UserDefaults` JSON editing; flexible but unfriendly.
- **C — Per-file rules**: custom retention per log file; larger surface and validation burden.
