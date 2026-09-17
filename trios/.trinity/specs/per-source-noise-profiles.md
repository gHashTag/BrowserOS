# Spec — Per-Source Noise Profiles (Cycle 50)

**Ring:** SR-02 / BR-OUTPUT  
**Road:** B (balanced)  
**Date:** 2026-07-27  
**Closes:** gHashTag/trios#1084

## 1. Problem

Cycle 49 made noise rules user-editable, but every rule is global. A rule that hides `watchdog_heartbeat` or a companion health-check string applies across **all** log sources. In practice, the same event/message can be noise in one source (e.g. `browseros-companion.log`) and signal in another (e.g. `queen.log`). Users need to scope a rule to one or more sources, like Datadog's `log_processing_rules` scoped by `source`/`service`, Loki's stream selectors, or Splunk's `host::`/`source::` transforms.

## 2. Goal

Add an optional `sourceIDs` scope to `LogNoiseRule`. Rules with no scope remain global and keep Cycle 49 behavior. Rules with a scope only match lines whose `ParsedLogLine.sourceID` is in the scope. The contextual "Hide events like this" action defaults to the source of the line, and the rules sheet lets the user widen or narrow that scope.

## 3. Data model

```swift
struct LogNoiseRule: Codable, Equatable, Identifiable, Sendable {
    let id: String
    var label: String
    var event: String?
    var message: String?
    var raw: String?
    var sourceIDs: [String]?   // nil / empty = global
    var enabled: Bool

    init(
        id: String = UUID().uuidString,
        label: String,
        event: String? = nil,
        message: String? = nil,
        raw: String? = nil,
        sourceIDs: [String]? = nil,
        enabled: Bool = true
    ) { ... }

    var isValid: Bool { ... }

    /// True if this rule applies to the given source.
    func applies(toSourceID sourceID: String) -> Bool {
        guard let ids = sourceIDs, !ids.isEmpty else { return true }
        return ids.contains(sourceID)
    }
}
```

- `sourceIDs` is optional and defaults to `nil`. Existing stored profiles decode unchanged (global behavior).
- Add `applies(toSourceID:)` helper for clarity and testing.

## 4. Filter behavior

In `LogNoiseFilter.matches(rule:line:)`:

```swift
private func matches(_ rule: LogNoiseRule, _ line: ParsedLogLine) -> Bool {
    guard rule.applies(toSourceID: line.sourceID) else { return false }
    // existing event / message / raw checks unchanged
}
```

This keeps all existing rules global while honoring scoped rules.

## 5. Pattern proposer

Update `LogNoisePatternProposer.propose(from:sourceID:)`:

```swift
static func propose(
    from line: ParsedLogLine,
    sourceID: String? = nil,
    label: String? = nil
) -> LogNoiseRule? {
    // existing event/message/raw derivation
    return LogNoiseRule(
        label: label ?? ...,
        event: ...,
        message: ...,
        raw: ...,
        sourceIDs: sourceID.map { [$0] },
        enabled: true
    )
}
```

When the user invokes "Hide events like this" from a log row, pass the row's source. The sheet can later widen the rule to all sources.

## 6. UI changes

### 6.1 `NoiseProfileSheet`

- Accept `availableSources: [LogSource]` so the sheet can render source names.
- In the rule editor, show the rule's scope:
  - `sourceIDs == nil` → "All sources" chip.
  - otherwise → chips with each source's `displayName`.
- Add a source-scope menu per rule:
  - "All sources" item sets `sourceIDs = nil`.
  - One item per available source toggles inclusion and adds a checkmark when included.
- When `pendingRule` has a source scope, show that in the preview card.

### 6.2 Context menu

In both the source-detail `logRow` and the unified-timeline `unifiedLogRow`, call:

```swift
if let rule = LogNoisePatternProposer.propose(from: line, sourceID: line.sourceID) { ... }
```

The context menu label remains "Hide events like this".

### 6.3 Count preview

`countLinesMatching(_:)` already uses `LogNoiseFilter`, so source-scoped rules automatically count only matching-source lines.

## 7. Tests to add

Add to `tests/TriOSKitTests/LogsTabViewTests.swift`:

- `testSourceScopedRuleFiltersOnlyMatchingSource` — a rule scoped to `source-a` suppresses a line from `source-a` but not an identical line from `source-b`.
- `testGlobalRuleStillAppliesToAllSources` — a rule with `sourceIDs == nil` suppresses identical lines across sources.
- `testRuleAppliesToSourceIDHelper` — `applies(toSourceID:)` returns true for nil/empty and false for mismatches.
- `testProposerIncludesSourceIDWhenProvided` — `propose(from:sourceID:)` sets `sourceIDs` to `[sourceID]`.
- `testLegacyProfileWithoutSourceIDsDecodesAsGlobal` — old JSON round-trips and behaves globally.
- `testFilterNoiseRespectsSourceScope` — `LogParser.filterNoise` with a scoped profile returns the correct filtered array.

## 8. Verification gates

- `cargo run --bin clade-build` ✅
- `cargo run --bin clade-e2e` ✅
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` ✅ 0 hard-gate findings
- `cargo run --bin clade-seal` ✅ SEAL VALID
- `cargo test -p trios-mesh` ✅
- `open trios.app` and confirm menu-bar logo present.

## 9. Migration / compatibility

No migration needed. The new field is optional and decodes as `nil` from existing `.trinity/state/logs_noise_profile.json`. Built-in default rules remain global (`sourceIDs == nil`).
