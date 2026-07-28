# Cycle 52 Report — LOGS Tab Noise Rule Auto-Suggest

**Issue:** gHashTag/trios#1086  
**Date:** 2026-07-27  
**Ring:** SR-02 / BR-OUTPUT  
**Road:** B (balanced)  
**Agent:** claude / T27 Creator  

## 1. Summary

Cycles 49-51 gave TriOS users editable, source-scoped, portable log-noise profiles. Cycle 52 closes the final UX gap: the app now **proposes** new source-scoped noise rules by analyzing the frequency of events and message phrases in the logs that are currently loaded. Users see a "Suggested rules" section inside the noise-profile sheet, each row showing the source, the pattern, how many lines it would suppress, and a one-tap **Add** button.

The feature is deterministic, fully local, and unit-testable — no backend or ML dependency.

## 2. Weak spot addressed

Users still had to notice repetitive noise themselves and manually craft a rule. Competitors (Datadog Log Patterns, Grafana Adaptive Logs, Splunk Patterns tab) all surface high-frequency clusters with one-click suppression. TriOS now matches that workflow with a lightweight, deterministic engine.

## 3. Implementation

### 3.1 Analysis model

`trios/rings/SR-02/LogParser.swift`

```swift
struct LogNoiseSuggestion: Equatable, Identifiable, Sendable {
    let id: String
    let rule: LogNoiseRule
    let sourceID: String
    let matchedCount: Int
    let sampleLine: String
}
```

### 3.2 Suggestion engine

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

Algorithm:
1. Group loaded lines by `(sourceID, event)` where `event` is non-empty.
2. For pairs above `minOccurrences`, check if the current profile already suppresses a synthetic line with that event.
3. If not covered, create a source-scoped `LogNoiseRule(event: ...)`, count matched lines, and rank by `matchedCount`.
4. If no event-bearing patterns qualify, fall back to message phrases using the same `longestSignificantPhrase` heuristic as `LogNoisePatternProposer`, rejecting short tokens, pure numbers, and common broad words.

### 3.3 UI changes

`trios/BR-OUTPUT/LogsTabView.swift`

- Added `suggestions` state and `recomputeSuggestions()` inside `NoiseProfileSheet`.
- New "Suggested rules" section between the preview card and the custom rules list.
- Each row shows: source chip, event/message preview, "Suppresses N lines", and an **Add** button.
- Tapping **Add** inserts the rule at the top of `localRules`, persists the profile, and removes the suggestion.
- Empty state: "No repetitive patterns detected in current logs."

### 3.4 Tests

`trios/tests/TriOSKitTests/LogsTabViewTests.swift`

- `testSuggesterProposesHighFrequencyEvent`
- `testSuggesterIgnoresAlreadyCoveredEvents`
- `testSuggesterLimitsTopNResults`
- `testSuggesterRequiresMinimumOccurrences`
- `testSuggesterSourceScopeMatchesOnlyThatSource`

## 4. Files changed

- `trios/rings/SR-02/LogParser.swift` — `LogNoiseSuggestion`, `LogNoiseSuggester`, source-scoped frequency analysis.
- `trios/BR-OUTPUT/LogsTabView.swift` — "Suggested rules" UI in `NoiseProfileSheet`.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` — 5 new auto-suggest tests.
- `trios/.trinity/specs/noise-rule-auto-suggest.md` — Cycle 52 spec.
- `trios/.claude/plans/trios-cycle52-noise-auto-suggest.md` — Cycle 52 plan.
- `trios/.trinity/experience.md` — Cycle 52 closure entry.
- `trios/.trinity/ring-SR-02.md` — Verified pattern #6 (frequency-based auto-suggest).

## 5. Verification gates

| Gate | Result |
|------|--------|
| `cargo run --bin clade-build` | PASS |
| `cargo run --bin clade-e2e` | PASS (report: `.trinity/e2e/report_prod_1785204138.md`) |
| `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` | PASS — 0 hard-gate findings across 8 checks |
| `cargo run --bin clade-seal` | SEAL VALID |
| `cargo test -p trios-mesh` | PASS — 101 tests |
| `open trios.app` + health | PASS — `{"status":"ok","cdpConnected":true}` |

All source files remain ASCII-only. No new `*.sh` on the critical path. No persistence format change.

## 6. Law compliance

| Law | Verdict |
|-----|---------|
| L1 TRACEABILITY | PASS — GitHub issue #1086 created and referenced in spec/plan/report |
| L2 GENERATION | PASS — T27 Creator produced canon SR-02/BR-OUTPUT changes, spec-first |
| L3 PURITY | PASS — ASCII-only identifiers and UI text |
| L4 TESTABILITY | PASS — clade-build, clade-e2e, clade-audit, clade-seal, mesh tests all pass |
| L5 IDENTITY | PASS — no sacred constants touched |
| L6 CEILING | PASS — UI changes confined to `LogsTabView.swift` |
| L7 UNITY | PASS — no new shell scripts on critical path |

## 7. Three options for Cycle 53

1. **Noise rule impact dashboard** — Show per-rule statistics (lines suppressed today, last match, estimated noise-reduction %) so users can audit stale rules and clean them up.
2. **Encrypted / signed profile sharing** — Encrypt exported profiles with the TriOS Keychain key and sign them so teams can share trusted runbook filters without exposing internal log content.
3. **Rule expiration and TTL** — Allow setting a duration on custom rules (e.g. "suppress for 24 hours") so temporary incident filters auto-disable instead of becoming permanent noise traps.

## 8. Episode artifacts

- Experience JSON: `.trinity/experience/2026-07-27_logs-tab-noise-rule-auto-suggest-loop-052.json`
- Plan/Report: `.claude/plans/trios-cycle52-noise-auto-suggest.md` / `.claude/plans/trios-cycle52-noise-auto-suggest-report.md`
- Memory: `trios-cycle52-noise-rule-auto-suggest.md`
