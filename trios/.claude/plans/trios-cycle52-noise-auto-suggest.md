:
# Cycle 52 Plan — Noise Rule Auto-Suggest

**Prompt:** "исследуй слабые места задачи, исследуй конкурентов по теме, создай декомпозированный план и реализуй все и в конце отчет и три варианта"  
**Closes:** gHashTag/trios#1086

## 1. Weak spot

Cycles 49-51 gave users manual tools to create, scope, and share noise rules. But the app never helps the user discover what is noisy. A user still has to:
- notice a repetitive pattern themselves;
- right-click a row and create a rule;
- guess whether the pattern is worth suppressing.

Competitors (Datadog Log Patterns, Grafana Adaptive Logs, Splunk Patterns tab) all auto-detect high-frequency patterns and suggest suppressions. TriOS has no equivalent.

## 2. Competitor research

| Product | Auto-suggest pattern | UX |
|---|---|---|
| **Datadog** | Log Patterns clusters 10k samples by message format; one-click **Add Exclusion Filter**. | Patterns view shows top clusters by service/status with counts. |
| **Grafana Loki** | Adaptive Logs groups logs into patterns, analyzes 15-day query history, suggests drop rates for rarely queried patterns. | Recommendations list with frequency + drop-rate slider. |
| **Splunk** | Patterns tab / `cluster` command groups events by structure and shows counts; can save as event type or alert. | Search-results side tab with prevalence and sample SPL. |

Common pattern: **frequency-based pattern detection + one-click suppression suggestion**. TriOS can do a deterministic local version without ML.

## 3. Chosen variant

**Road B — Add a "Suggested rules" section to `NoiseProfileSheet` that proposes source-scoped noise rules based on loaded log frequency.**

Reasons:
- No backend or network dependency.
- Deterministic and fully unit-testable.
- Builds directly on Cycle 50 source scoping and Cycle 51 rule model.
- Small, reviewable diff.

## 4. Decomposition

### 4.1 Analysis model

```swift
struct LogNoiseSuggestion: Equatable, Identifiable, Sendable {
    let id: String
    let rule: LogNoiseRule
    let sourceID: String
    let matchedCount: Int
    let sampleLine: String
}
```

### 4.2 Suggestion engine

Add `LogNoiseSuggester` in `LogParser.swift`:

```swift
enum LogNoiseSuggester {
    /// Analyze loaded log sources and propose noise rules for high-frequency patterns
    /// that are not already covered by the current profile.
    static func suggest(
        from sources: [LogSource],
        profile: LogNoiseProfile,
        minOccurrences: Int = 5,
        topN: Int = 10
    ) -> [LogNoiseSuggestion]
}
```

Algorithm:
1. For each source, group lines by `event` when present.
2. Count occurrences per `(sourceID, event)` pair.
3. For events above `minOccurrences`, check if the profile already suppresses them (use `LogNoiseFilter.isNoise` with a synthetic line).
4. If not covered, create a source-scoped `LogNoiseRule(event: ...)` and count matched lines.
5. Sort by `matchedCount` descending, take `topN`.
6. If no events are available, fall back to message phrases (use the same `longestSignificantPhrase` logic as `LogNoisePatternProposer`).

### 4.3 UI changes

In `NoiseProfileSheet`:
- Add a new section "Suggested rules" between the preview card and the custom rules list.
- Each suggestion shows: source name chip, event/message preview, "Suppresses N lines" count, **Add** button.
- Clicking **Add** inserts the rule at the top of custom rules and persists immediately.
- If no suggestions, show a brief empty state: "No repetitive patterns detected in current logs."

### 4.4 Tests

Add to `LogsTabViewTests.swift`:
- `testSuggesterProposesHighFrequencyEvent` — repeated event in one source produces a suggestion.
- `testSuggesterIgnoresAlreadyCoveredEvents` — existing profile rule prevents duplicate suggestion.
- `testSuggesterLimitsTopNResults` — only returns up to `topN` suggestions.
- `testSuggesterRequiresMinimumOccurrences` — patterns below threshold are ignored.
- `testSuggesterSourceScopeMatchesOnlyThatSource` — suggestion rule is scoped to the source it came from.

### 4.5 Verification gates

- `cargo run --bin clade-build`
- `cargo run --bin clade-e2e`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`
- `cargo run --bin clade-seal`
- `cargo test -p trios-mesh`
- `open trios.app` + menu-bar logo check

## 5. Roadmap handoff options for Cycle 53

1. **Noise rule impact dashboard** — show per-rule statistics (lines suppressed today, last match, estimated noise reduction %) so users can audit and clean up stale rules.  
2. **Encrypted / signed profile sharing** — encrypt exported profiles with the TriOS Keychain key and sign them so teams can share trusted runbook filters.  
3. **Rule expiration and TTL** — allow setting a duration on custom rules (e.g. "suppress for 24 hours") so temporary incident filters auto-disable instead of becoming permanent noise traps.
