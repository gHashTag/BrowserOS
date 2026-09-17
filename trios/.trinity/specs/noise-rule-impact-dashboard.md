# Spec — Noise Rule Impact Dashboard (Cycle 53)

**Ring:** SR-02 / BR-OUTPUT  
**Road:** B (balanced)  
**Date:** 2026-07-28  
**Closes:** gHashTag/trios#1087

## 1. Problem

Cycles 48-52 progressively built log-noise suppression in TriOS: a hard-coded quiet filter, user-configurable rules, per-source scoping, portable import/export, and auto-suggest. But once a rule exists, the user has no visibility into whether it is doing anything useful:

- A rule may suppress thousands of lines, but the sheet shows only a static count at creation time.
- A rule may have become stale because the underlying service stopped emitting the pattern.
- There is no way to compare total visible vs. suppressed volume to understand signal-to-noise improvement.
- There is no way to identify "zombie rules" that should be disabled or deleted.

## 2. Goal

Add a local "Rule impact" view inside the noise-profile sheet that shows per-rule and overall suppression statistics computed from the logs currently loaded in the LOGS tab. The statistics are deterministic, local, and fully testable.

## 3. Data model

```swift
struct LogNoiseRuleImpact: Equatable, Sendable {
    let ruleID: String
    let label: String
    let sourceIDs: [String]?
    let matchedCount: Int
    let totalLinesForScope: Int
    var suppressionPercent: Double { totalLinesForScope > 0 ? Double(matchedCount) / Double(totalLinesForScope) * 100 : 0 }
    let lastSeenSampleLine: String?
}

struct LogNoiseRuleImpactSummary: Equatable, Sendable {
    let totalVisibleLines: Int
    let totalSuppressedLines: Int
    let totalLines: Int
    var suppressionPercent: Double { totalLines > 0 ? Double(totalSuppressedLines) / Double(totalLines) * 100 : 0 }
    let ruleImpacts: [LogNoiseRuleImpact]
}
```

## 4. Impact analyzer

```swift
enum LogNoiseImpactAnalyzer {
    static func analyze(
        profile: LogNoiseProfile,
        sources: [LogSource]
    ) -> LogNoiseRuleImpactSummary
}
```

Algorithm:
1. Compute `totalLines` as the count of all loaded lines across all sources.
2. Run the full profile over all lines to count `totalSuppressedLines`; `totalVisibleLines = totalLines - totalSuppressedLines`.
3. For each rule in `profile.allRules`, build a temporary profile that includes that rule plus all default rules, and count matched lines.
4. Compute `totalLinesForScope`: if the rule is source-scoped, count lines from those sources only; otherwise use `totalLines`.
5. Capture one non-empty matched raw line as `lastSeenSampleLine`.
6. Return the summary sorted by `matchedCount` descending.

Constraints:
- Total suppressed is computed once with the full profile to avoid double-counting overlapping rules.
- Per-rule counts are computed with the rule in isolation (plus defaults) to show each rule's individual contribution.

## 5. UI changes

In `NoiseProfileSheet`:
- Add a segmented picker at the top: **Rules** | **Impact**.
- The **Rules** tab contains the existing editor, suggestions, import/export.
- The **Impact** tab contains:
  - Overall summary card: "Visible X lines | Suppressed Y lines | Z% noise reduction".
  - Per-rule rows: label, source scope chip(s), matched count, suppression percent, last-seen sample line (truncated), and a Delete/Disable action for custom rules.
  - Empty/stale state when a rule matches 0 lines: "No matches in current logs — rule may be stale".

## 6. Tests

Add to `tests/TriOSKitTests/LogsTabViewTests.swift`:

- `testImpactAnalyzerCountsTotalSuppressed` — overall suppression count equals noisy lines removed by the profile.
- `testImpactAnalyzerReportsPerRuleMatchedCount` — each rule's matched count reflects lines it alone would suppress (with defaults).
- `testImpactAnalyzerSourceScopedTotalLines` — source-scoped rule uses only its source's total for the percent denominator.
- `testImpactAnalyzerDetectsStaleRule` — rule that matches 0 lines reports `lastSeenSampleLine == nil`.
- `testImpactAnalyzerAvoidsDoubleCount` — two overlapping rules do not make total suppressed exceed total lines.

## 7. Migration

No persistence format change. Impact statistics are computed on demand from loaded logs.

## 8. Verification gates

- `cargo run --bin clade-build`
- `cargo run --bin clade-e2e`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`
- `cargo run --bin clade-seal`
- `cargo test -p trios-mesh`
- `open trios.app` + menu-bar logo check
