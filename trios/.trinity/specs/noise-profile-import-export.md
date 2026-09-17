:
# Spec — Noise Profile Import/Export (Cycle 51)

**Ring:** SR-02 / BR-OUTPUT  
**Road:** B (balanced)  
**Date:** 2026-07-27  
**Closes:** gHashTag/trios#1085

## 1. Problem

Cycle 50 made noise rules source-scoped, but profiles are still trapped on a single machine. Users cannot back up custom rules, share a tuned profile, load a runbook-curated default set, or version-control filters alongside code. Losing `.trinity/state/logs_noise_profile.json` means losing carefully scoped filters.

## 2. Goal

Add explicit **Import** and **Export** buttons to the noise-profile sheet. Exported profiles are portable JSON with a `schemaVersion` envelope so future rule fields can be migrated safely. Imported rules merge into the existing custom rule list, replacing rules with the same `id`.

## 3. Data model

### 3.1 Envelope

```swift
struct LogNoiseProfileEnvelope: Codable, Equatable, Sendable {
    var schemaVersion: Int   // current = 1
    var exportedAt: Date?    // ISO 8601 string when encoded
    var rules: [LogNoiseRule]
}
```

The envelope is used only for portable export/import. The store continues to persist `LogNoiseProfile.customRules` directly, so existing `.trinity/state/logs_noise_profile.json` is unchanged.

### 3.2 Store helpers

Extend `LogNoiseProfileStore`:

```swift
func exportRules(
    _ rules: [LogNoiseRule],
    to directory: String = NSHomeDirectory() + "/Downloads"
) -> URL?

func importRules(from url: URL) -> LogNoiseImportResult
```

### 3.3 Import result

```swift
struct LogNoiseImportResult: Equatable, Sendable {
    var imported: [LogNoiseRule]
    var skippedInvalid: Int
    var skippedUnsupportedSchema: Bool
}
```

## 4. Export behavior

- Encode `LogNoiseProfileEnvelope(schemaVersion: 1, exportedAt: Date(), rules: rules)`.
- Use a stable key order by encoding with `JSONEncoder.outputFormatting = .sortedKeys`.
- Default filename: `trios-noise-profile-YYYY-MM-DD-HHMMSS.json`.
- Write to `~/Downloads` via `FileManager`.
- Return the file URL for UI confirmation.

## 5. Import behavior

1. Read file data.
2. Decode `LogNoiseProfileEnvelope`.
3. If `schemaVersion` > 1, return `skippedUnsupportedSchema = true` and `imported = []`.
4. Validate every rule:
   - `rule.isValid` must be true (at least one matcher field non-empty);
   - keep `sourceIDs` as-is (even if source no longer exists — sources can come and go).
5. Merge imported rules into the current `localRules`:
   - Remove existing rules with the same `id`;
   - Insert imported rules at index 0 in file order.
6. Persist immediately via `onSave`.

## 6. UI changes

In `NoiseProfileSheet`:

- Header row adds an **Import** button (left) and an **Export** button (right) next to **Done**.
- **Export** writes the current `localRules` (after filtering invalid ones) to Downloads and shows a short status text.
- **Import** opens an `NSOpenPanel` restricted to `.json` files (UTType.json or plain `public.json`).
- After import, refresh `localRules` and show a summary status line:
  - "Imported N rules, skipped K invalid."
  - "Unsupported profile version." if schema > 1.
- Keep existing rule editor, source-scope chips, and preview card untouched.

## 7. Tests

Add to `tests/TriOSKitTests/LogsTabViewTests.swift`:

- `testEnvelopeRoundTrip` — encode/decode preserves `schemaVersion`, `exportedAt`, and all rule fields.
- `testExportWritesValidJSON` — export creates a file, decoding it yields the same rules.
- `testImportMergesAndReplacesByID` — importing a profile with a rule whose `id` already exists updates that rule, and new rules are prepended.
- `testImportRejectsUnknownSchemaVersion` — envelope with `schemaVersion: 99` returns empty `imported` and sets `skippedUnsupportedSchema`.
- `testImportSkipsInvalidRules` — envelope containing a rule with no matchers is dropped and counted in `skippedInvalid`.

## 8. Migration

No migration required. Existing `logs_noise_profile.json` stays the same. Only portable export files use the envelope.

## 9. Verification gates

- `cargo run --bin clade-build`
- `cargo run --bin clade-e2e`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`
- `cargo run --bin clade-seal`
- `cargo test -p trios-mesh`
- `open trios.app` + menu-bar logo check
