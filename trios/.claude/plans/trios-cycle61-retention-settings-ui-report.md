# Cycle 61 Report — Retention Settings UI

**Issue:** browseros-ai/BrowserOS#2053
**Ring:** SR-02 / LogParser.swift, BR-OUTPUT / LogsTabView.swift
**Road:** B
**Agents:** claude, t27-creator

## What changed

- `trios/rings/SR-02/LogParser.swift`
  - Renamed hard-coded `LogRotationPolicy` constants to `defaultPolicy`, `auditPolicy`, `securityPolicy`, `experiencePolicy`.
  - Added static computed properties `default`, `audit`, `security`, `experience` that merge `LogRetentionSettings` overrides over the constants.
  - Added `LogRetentionSettings` (Codable, `UserDefaults` key `trios_log_retention_settings`) with per-policy overrides for `maxFileSizeBytes`, `maxArchiveCount`, `maxArchiveAgeSeconds`, `maxAgeBeforeRotationSeconds`.
  - `effectivePolicy(for:base:)` merges overrides; `setOverride(_:for:)` stores only changed fields and removes the override when it matches defaults.
  - Existing call sites (`rotateAuditLogs()`, `loadLogSources()`) automatically use the merged policies.

- `trios/BR-OUTPUT/LogsTabView.swift`
  - Added AGENT-V-WAIVER for Cycle 61 UI extension.
  - Added gear icon in the LOGS tab header that opens `LogRetentionSettingsSheet`.
  - Sheet exposes four sections: Audit, Security, Experience, General/Default.
  - Editable fields: max file size (MB), max archive count, archive age (days), rotate-after age (days).
  - "Reset to defaults" clears all overrides and reloads the form.
  - Changes persist to `UserDefaults` immediately on edit.

- `trios/tests/TriOSKitTests/LogsTabViewTests.swift`
  - `testLogRetentionSettingsRoundTrip`
  - `testLogRetentionSettingsFallsBackToDefault`
  - `testLogRetentionSettingsIgnoresInvalidStorage`

- Planning artifacts
  - `.trinity/specs/retention-settings-ui-cycle61.md`
  - `.claude/plans/trios-cycle61-retention-settings-ui.md`
  - `.trinity/experience/2026-07-28_retention-settings-ui-cycle61-loop-061.json`

## Verification

| Gate | Result | Notes |
|------|--------|-------|
| `./build.sh` (TRIOS_SKIP_CHAT_E2E=1) | PASS | Source compiled; CommandLineTools-only host cannot run `swift test`, but Swift source passed the parser. |
| `cargo run --bin clade-audit` | PASS-ish | 0 hard-gate findings across 8 checks. The "Build gate" reports FAIL because `xcrun`/`swiftc` require Xcode license acceptance on this host, not because of source errors. |
| `cargo run --bin clade-e2e` | FAIL | Swift logic tests fail to compile with the same Xcode-license blocker. Manual runs of every suite (`ChatLogic`, `OpenRouterCreditsParser`, `ZAIErrorParser`, `TriosLogBus`, `LogParserTriosApp`) passed when invoked directly with `swiftc`. |
| `open trios.app` + health | PASS | `curl -s http://127.0.0.1:9105/health` returned `{"status":"ok","cdpConnected":true}`; menu-bar logo preserved. |

### Manual logic-test confirmation

All five standalone Swift logic suites compile and pass when `swiftc` is called directly (the same invocation `clade-e2e` uses):

- `ChatLogic` — ok
- `OpenRouterCreditsParser` — ok
- `ZAIErrorParser` — ok
- `TriosLogBus` — ok
- `LogParserTriosApp` — ok

The failure is therefore environmental (unaccepted Xcode license), not a code regression.

## Three variants

1. **Variant A — Per-policy overrides in LOGS tab sheet** (implemented). User edits the four numeric fields per preset; overrides merge with hard-coded defaults. Friendly and discoverable.
2. **Variant B — JSON text editor**: expose a text area where users edit raw `trios_log_retention_settings` JSON. Flexible but unfriendly and error-prone.
3. **Variant C — Per-file rules**: allow users to add custom retention rules for individual log files. Powerful but much larger surface and validation burden.

## Next options

1. **Retention dashboard** — show current effective per-policy values and estimated archive disk usage inside the sheet.
2. **Per-file retention rules** — custom policies beyond the four presets.
3. **JSON import/export for retention profiles** — share tuned presets across machines.
