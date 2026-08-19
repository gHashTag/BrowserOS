:
# Cycle 51 Report — Noise Profile Import/Export

**Issue:** gHashTag/trios#1085  
**Ring:** SR-02 / BR-OUTPUT  
**Road:** B (balanced)  
**Date:** 2026-07-27

## 1. Weak spot

Cycle 50 added source-scoped noise rules, but the resulting profile was trapped on a single machine. Users could not:

- back up custom rules before reinstalling TriOS;
- share a tuned profile with a teammate;
- load a runbook-curated default set for a specific incident type;
- diff or version-control noise rules alongside code.

Losing `.trinity/state/logs_noise_profile.json` meant losing carefully scoped filters.

## 2. Competitor research

| Product | Profile/portability pattern | UX |
|---|---|---|
| **Datadog** | Security suppression rules and agent `log_processing_rules` are JSON/YAML via API/Terraform; no single "share profile" UI, but configs are code. | Export/import through API or Terraform; team sharing via version control. |
| **Grafana** | Alerting rules and silences provisioned as JSON through the Alerting Provisioning API; dashboards export/import as JSON. | JSON export in UI, import via API or UI file picker. |
| **Splunk** | ITSI aggregation policies managed via Terraform/REST; configs live in knowledge objects that can be bundled. | Admin-driven export/import, not end-user file sharing. |
| **logdelve** | Named sessions persist filter sets; filtered results export to a file. | Session save/load inside the app, not portable JSON. |
| **SigNoz / Forge dashboards** | Dashboards and alert groups export/import as JSON for portability and version control. | Explicit JSON export/import buttons in the UI. |

Strongest pattern for TriOS: **explicit JSON Import/Export buttons in the noise-profile sheet**, plus a lightweight schema version so future rule fields can be migrated safely.

Sources: [Datadog suppression rules](https://docs.datadoghq.com/api/latest/security-monitoring/create-a-suppression-rule.md), [Grafana alerting provisioning](https://grafana.com/docs/grafana/latest/developers/http_api/alerting_provisioning/), [Splunk ITSI aggregation policies](https://help.splunk.com/en/splunk-it-service-intelligence/splunk-it-service-intelligence/detect-and-act-on-notable-events/4.21/event-aggregation/overview-of-aggregation-policies-in-itsi), [logdelve sessions](https://github.com/chassing/logdelve), [SigNoz querying](https://signoz.io/docs/logs-management/querying-logs/).

## 3. Chosen variant

**Road B — Add Import/Export buttons to `NoiseProfileSheet`, with `schemaVersion` on the profile envelope.**

Reasons:
- Directly extends Cycle 49/50 UI with no new backend.
- Uses the same JSON persistence layer the app already has.
- `schemaVersion` makes future migrations safe.
- Small, reviewable diff that keeps the menu-bar logo invariant.

## 4. Decomposition & implementation

### 4.1 Data model

```swift
struct LogNoiseProfileEnvelope: Codable, Equatable, Sendable {
    var schemaVersion: Int   // current = 1
    var exportedAt: Date?
    var rules: [LogNoiseRule]
}

struct LogNoiseImportResult: Equatable, Sendable {
    var imported: [LogNoiseRule]
    var skippedInvalid: Int
    var skippedUnsupportedSchema: Bool
}
```

The store persists `LogNoiseProfile.customRules` directly; the envelope is only for portable files.

### 4.2 Export

- Encodes `LogNoiseProfileEnvelope(schemaVersion: 1, exportedAt: Date(), rules: rules)`.
- Uses `JSONEncoder.outputFormatting = .sortedKeys` for stable diffs.
- Filename: `trios-noise-profile-YYYY-MM-DD-HHMMSS.json`.
- Destination: `~/Downloads`.

### 4.3 Import

- Reads `.json`, decodes envelope.
- Rejects `schemaVersion > 1`.
- Filters rules where `!rule.isValid`.
- Merges into current custom rules: replace by `id`, prepend new rules.
- Persists immediately via `onSave`.

### 4.4 UI changes

- `NoiseProfileSheet` header now has **Import** and **Export** buttons next to **Done**.
- Export shows the exported filename in a status line.
- Import opens `NSOpenPanel` restricted to `.json`.
- After import, the status line shows: "Imported N rules, skipped K invalid." or "Unsupported profile version."
- Existing rule editor, source-scope chips/menu, and preview card are untouched.

### 4.5 Tests

- `testEnvelopeRoundTrip`
- `testExportWritesValidJSON`
- `testImportMergesAndReplacesByID`
- `testImportRejectsUnknownSchemaVersion`
- `testImportSkipsInvalidRules`

## 5. Files changed

- `trios/rings/SR-02/LogParser.swift` — `LogNoiseProfileEnvelope`, `LogNoiseImportResult`, `exportRules`, `importRules`.
- `trios/BR-OUTPUT/LogsTabView.swift` — Import/Export buttons, status line, `NSOpenPanel` helper, `UniformTypeIdentifiers` import.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` — five import/export tests.
- `trios/.trinity/specs/noise-profile-import-export.md` — spec + issue link.
- `trios/.claude/plans/trios-cycle51-noise-profile-import-export.md` — plan + issue link.
- `trios/.claude/plans/trios-cycle51-noise-profile-import-export-report.md` — this report.
- `trios/.trinity/experience/2026-07-27_logs-tab-noise-profile-import-export-loop-051.json` — episode.

## 6. Verification gates

| Gate | Result |
|---|---|
| `cargo run --bin clade-build` | PASS |
| `cargo run --bin clade-e2e` | PASS (report `.trinity/e2e/report_prod_1785203017.md`) |
| `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` | PASS — 0 hard-gate findings across 8 checks |
| `cargo run --bin clade-seal` | SEAL VALID |
| `cargo test -p trios-mesh` | PASS — 101/101 tests |
| `open trios.app` | Relaunched, multiple trios processes present, menu-bar logo preserved |

## 7. Verdict

Cycle 51 is **CLEAN** and ready for land. The land commit must carry:

```
Closes gHashTag/trios#1085
```

## 8. Three future options

1. **Per-source built-in presets and auto-suggest** — analyze per-source frequency patterns and propose new source-scoped rules automatically, closing the feedback loop between user edits and built-in defaults.  
2. **Encrypted / signed profile sharing** — encrypt exported profiles with the TriOS Keychain key and sign them so teams can share trusted runbook filters without exposing internal log content.  
3. **Cloud-synced profiles across TriOS instances** — persist the noise profile in the encrypted recovery package or a BrowserOS preference endpoint so filters follow the user across machines.
