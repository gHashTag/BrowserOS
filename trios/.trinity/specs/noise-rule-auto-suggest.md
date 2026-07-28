:
# Spec — Noise Rule Auto-Suggest (Cycle 52)

**Ring:** SR-02 / BR-OUTPUT  
**Road:** B (balanced)  
**Date:** 2026-07-27  
**Closes:** gHashTag/trios#1086

## 1. Problem

Cycles 49-51 gave users manual tools to create, scope, and share noise rules. But the app never helps the user discover what is noisy. A user must notice a repetitive pattern themselves, right-click a row, and decide whether it is worth suppressing. Competitors (Datadog Log Patterns, Grafana Adaptive Logs, Splunk Patterns tab) all auto-detect high-frequency patterns and suggest suppressions.

## 2. Goal

Add a "Suggested rules" section to `NoiseProfileSheet` that proposes source-scoped noise rules based on loaded log frequency. The suggestions are deterministic, local, and fully testable.

## 3. Data model

### 3.1 Suggestion

```swift
struct LogNoiseSuggestion: Equatable, Identifiable, Sendable {
    let id: String
    let rule: LogNoiseRule
    let sourceID: String
    let matchedCount: Int
    let sampleLine: String
}
```

### 3.2 Suggester

```swift
enum LogNoiseSuggester {
    static func suggest(
        from sources: [LogSource],
        profile: LogNoiseProfile,
        minOccurrences: Int = 5,
        topN: Int = 10
    ) -> [LogNoiseSuggestion]
}
```

## 4. Suggestion algorithm

1. For each source, group lines by `event` when `event` is non-empty.
2. Count occurrences per `(sourceID, event)` pair.
3. For each pair above `minOccurrences`, test whether the current profile already suppresses it:
   - Build a synthetic `ParsedLogLine` with the same `sourceID` and `event`;
   - Run `LogNoiseFilter(profile: profile).isNoise(syntheticLine)`;
   - If already suppressed, skip.
4. Create a source-scoped `LogNoiseRule(event: event, sourceIDs: [sourceID])`.
5. Count how many real lines match the rule (reuse `LogNoiseFilter`).
6. Sort suggestions by `matchedCount` descending, take `topN`.
7. If no event-bearing lines qualify, fall back to message phrases using the same `longestSignificantPhrase` heuristic as `LogNoisePatternProposer`.

## 5. UI changes

In `NoiseProfileSheet`:
- Add `@State private var suggestions: [LogNoiseSuggestion] = []`.
- Compute suggestions in `onAppear` and after `localRules` changes.
- Add a "Suggested rules" section below the preview card and above "Custom rules".
- Each suggestion row:
  - Source name chip on the left.
  - Event/message preview in the middle.
  - "Suppresses N lines" count.
  - **Add** button on the right.
- Clicking **Add** inserts the suggestion's rule at the top of `localRules`, persists via `onSave`, and removes the suggestion from the list.
- Empty state: "No repetitive patterns detected in current logs."

## 6. Tests

Add to `tests/TriOSKitTests/LogsTabViewTests.swift`:

- `testSuggesterProposesHighFrequencyEvent` — repeated event in one source produces a suggestion.
- `testSuggesterIgnoresAlreadyCoveredEvents` — existing profile rule prevents duplicate suggestion.
- `testSuggesterLimitsTopNResults` — only returns up to `topN` suggestions.
- `testSuggesterRequiresMinimumOccurrences` — patterns below threshold are ignored.
- `testSuggesterSourceScopeMatchesOnlyThatSource` — suggestion rule is scoped to the source it came from.

## 7. Migration

No persistence format change. Suggestions are computed on demand from loaded logs.

## 8. Verification gates

- `cargo run --bin clade-build`
- `cargo run --bin clade-e2e`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`
- `cargo run --bin clade-seal`
- `cargo test -p trios-mesh`
- `open trios.app` + menu-bar logo check
