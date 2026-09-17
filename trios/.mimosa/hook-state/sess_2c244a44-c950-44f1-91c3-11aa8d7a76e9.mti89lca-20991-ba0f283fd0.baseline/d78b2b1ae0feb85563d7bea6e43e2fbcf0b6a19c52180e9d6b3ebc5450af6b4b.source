:
# Cycle 51 Plan — Noise Profile Import/Export

**Prompt:** "исследуй слабые места задачи, исследуй конкурентов по теме, создай декомпозированный план и реализуй все и в конце отчет и три варианта"  
**Closes:** gHashTag/trios#1085

## 1. Weak spot

Cycle 50 added source-scoped noise rules, but profiles are still trapped on a single machine. A user cannot:
- back up their custom rules before reinstalling TriOS;
- share a tuned profile with a teammate;
- load a runbook-curated default set for a specific incident type;
- diff or version-control noise rules alongside code.

If the `.trinity/state/logs_noise_profile.json` file is lost or migrated by hand, the user loses their carefully scoped filters.

## 2. Competitor research

| Product | Profile/portability pattern | UX |
|---|---|---|
| **Datadog** | Security suppression rules and agent `log_processing_rules` are JSON/YAML via API/Terraform; no single "share profile" UI, but configs are code. | Export/import through API or Terraform; team sharing via version control. |
| **Grafana** | Alerting rules and silences provisioned as JSON through the Alerting Provisioning API; dashboards export/import as JSON. | JSON export in UI, import via API or UI file picker. |
| **Splunk** | ITSI aggregation policies managed via Terraform/REST; configs live in knowledge objects that can be bundled. | Admin-driven export/import, not end-user file sharing. |
| **logdelve** | Named sessions persist filter sets; filtered results export to a file. | Session save/load inside the app, not portable JSON. |
| **SigNoz / Forge dashboards** | Dashboards and alert groups export/import as JSON for portability and version control. | Explicit JSON export/import buttons in the UI. |

Strongest pattern for TriOS: **explicit JSON Import/Export buttons in the noise-profile sheet**, plus a lightweight schema version so future rule fields can be migrated safely.

## 3. Chosen variant

**Road B — Add Import/Export buttons to `NoiseProfileSheet`, with `schemaVersion` on the profile envelope.**

Reasons:
- Directly extends Cycle 49/50 UI with no new backend.
- Uses the same JSON persistence layer the app already has.
- `schemaVersion` makes future migrations safe (e.g. adding regex matchers, severity scoping, or rule statistics).
- Small, reviewable diff that keeps the menu-bar logo invariant.

## 4. Decomposition

### 4.1 Data model

Introduce a wrapper envelope for export/import:

```swift
struct LogNoiseProfileEnvelope: Codable, Equatable, Sendable {
    var schemaVersion: Int   // current = 1
    var exportedAt: Date?    // ISO 8601
    var rules: [LogNoiseRule]
}
```

Keep `LogNoiseProfile` unchanged — the store persists the same `customRules` array. The envelope is only used when writing/reading a portable file.

### 4.2 Export

- Add `LogNoiseProfileStore.exportRules(_:to:)` (or a static helper on `LogNoiseProfileEnvelope`).
- Write JSON with `schemaVersion: 1`, optional `exportedAt`, and sorted rules for stable diffs.
- Default filename: `trios-noise-profile-YYYY-MM-DD-HHMMSS.json`.
- Destination: `~/Downloads` via `FileManager` (same pattern as `LogParser.exportLines`).
- UI: **Export rules** button in `NoiseProfileSheet` header.

### 4.3 Import

- Add `LogNoiseProfileStore.importRules(from:)` that:
  1. Reads file data;
  2. Decodes `LogNoiseProfileEnvelope`;
  3. Validates `schemaVersion` (accepts 1, warns/fails on >1);
  4. Sanitizes rules (`isValid`, non-empty source IDs reference real sources if provided);
  5. Returns `[LogNoiseRule]`.
- UI: **Import rules** button opens `NSOpenPanel` (allowed content types: `.json`).
- Imported rules are **merged** at the top of `localRules`, replacing any with the same `id` to avoid duplicates.
- Show a summary alert: added / updated / skipped count.

### 4.4 UI changes

In `NoiseProfileSheet`:
- Header row gets two icon buttons: **Import** and **Export**.
- After import, the sheet refreshes `localRules` and `profile`.
- Keep the existing rule editor, preview card, and source scope menu untouched.

### 4.5 Tests

Add to `LogsTabViewTests.swift`:
- `testEnvelopeRoundTrip` — encode/decode preserves rules and schema version.
- `testExportWritesValidJSON` — export creates a readable file with `schemaVersion: 1`.
- `testImportMergesRules` — import adds new rules and updates existing ones by `id`.
- `testImportRejectsUnknownSchemaVersion` — future schema version returns empty/error.
- `testImportSkipsInvalidRules` — rules with no matchers are dropped.

### 4.6 Verification gates

- `cargo run --bin clade-build`
- `cargo run --bin clade-e2e`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`
- `cargo run --bin clade-seal`
- `cargo test -p trios-mesh`
- `open trios.app` + menu-bar logo check

## 5. Roadmap handoff options for Cycle 52

1. **Per-source built-in presets and auto-suggest** — mine per-source frequency patterns and propose source-scoped rules, closing the loop between user edits and defaults.  
2. **Encrypted / signed profile sharing** — encrypt exported profiles with the TriOS Keychain key and sign them so teams can share trusted runbook filters without exposing internal log content.  
3. **Cloud-synced profiles across TriOS instances** — persist the noise profile in the encrypted recovery package or a BrowserOS preference endpoint so filters follow the user across machines.
