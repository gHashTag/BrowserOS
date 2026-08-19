# Cycle 53 Plan — Noise Rule Impact Dashboard

**Prompt:** "исследуй слабые места задачи, исследуй конкурентов по теме, создай декомпозированный план и реализуй все и в конце отчет и три варианта"  
**Closes:** gHashTag/trios#1087

## 1. Weak spot

Cycles 48-52 progressively built log-noise suppression in TriOS: a hard-coded quiet filter, user-configurable rules, per-source scoping, portable import/export, and auto-suggest. But once a rule exists, the user has **no visibility into whether it is doing anything useful**:

- A rule may suppress thousands of lines, but the sheet shows only a static count at creation time.
- A rule may have become stale because the underlying service stopped emitting the pattern.
- A user cannot compare total visible vs. suppressed volume to understand signal-to-noise improvement.
- There is no way to identify "zombie rules" that should be disabled or deleted.
- There is no feedback loop to refine the built-in default rules from observed custom-rule usage.

Competitors treat impact measurement as a first-class feature. Datadog Log Patterns shows a mini graph of pattern volume over time and recommends exclusion filters with estimated reduction. Grafana Adaptive Logs has a dedicated Overview dashboard with **Dropped log volume %**, **Total dropped**, **Total received**, and per-second rate graphs. Splunk Enterprise Security has an Audit dashboard for suppression rules and an Executive Summary that can optionally include/exclude suppressed findings.

TriOS has nothing equivalent: the only "metric" is the initial suppression-count preview shown when a rule is suggested or previewed.

## 2. Competitor research

| Product | Impact/audit feature | UX |
|---|---|---|
| **Datadog Log Patterns** | Per-pattern volume mini-graph + count by service/status; custom log-based metrics from exclusion queries. | Patterns view shows timeline + count; anomaly monitors alert when excluded volume changes. |
| **Grafana Adaptive Logs** | Overview dashboard: Dropped log volume %, Total dropped, Total received, Volume rates (received vs dropped per second). | Reachable under Adaptive Telemetry > Adaptive Logs > Overview; focuses on cost/retention savings. |
| **Splunk Enterprise Security** | Suppression Audit dashboard + Executive Summary toggle "Include suppressed findings"; Security Posture counts suppressed findings. | Centralized audit + optional inclusion in executive metrics. |

Common pattern: **measure suppressed volume in real time, expose per-rule statistics, and provide an audit view for stale/orphaned rules**.

TriOS can do a lightweight local version because all logs are already loaded into memory and `LogNoiseFilter` is deterministic.

## 3. Chosen variant

**Road B — Add a local "Rule impact" dashboard inside the noise-profile sheet that shows per-rule statistics computed from currently loaded logs.**

Reasons:
- No backend or network dependency.
- Fully deterministic and testable.
- Builds directly on Cycle 49-52 rule model and `LogNoiseFilter`.
- Small, reviewable diff.
- Addresses the most immediate UX gap after auto-suggest (users will now have many rules and need to audit them).

Rejected at this stage:
- Encrypted/signed sharing (Cycle 51 already made profiles portable; encryption is a trust enhancement, not an observability gap).
- TTL rules (useful, but impact measurement is needed first to justify disabling/deleting stale rules).

## 4. Decomposition

### 4.1 Data model

Add to `LogParser.swift`:

```swift
struct LogNoiseRuleImpact: Equatable, Sendable {
    let ruleID: String
    let sourceIDs: [String]?
    let matchedCount: Int
    let totalLinesForScope: Int
    var suppressionPercent: Double { totalLinesForScope > 0 ? Double(matchedCount) / Double(totalLinesForScope) * 100 : 0 }
    let lastSeenSampleLine: String?
}

enum LogNoiseRuleImpactSummary: Equatable, Sendable {
    let totalVisibleLines: Int
    let totalSuppressedLines: Int
    let suppressionPercent: Double
    let ruleImpacts: [LogNoiseRuleImpact]
}
```

### 4.2 Impact calculator

Add `LogNoiseImpactAnalyzer` in `LogParser.swift`:

```swift
enum LogNoiseImpactAnalyzer {
    static func analyze(
        rules: [LogNoiseRule],
        sources: [LogSource],
        profile: LogNoiseProfile
    ) -> LogNoiseRuleImpactSummary
}
```

Algorithm:
1. Run the full profile over all loaded lines to count total suppressed lines.
2. For each rule, create a temporary profile containing **only** that rule (+ default rules if it is a custom rule) and count matched lines.
3. Compute `totalLinesForScope` for each rule: if `sourceIDs` is set, count lines from those sources; otherwise count all lines.
4. Capture one sample matched line (non-empty raw line) as `lastSeenSampleLine`.
5. Compute overall suppression percent.

Notes:
- Custom rules and default rules are analyzed together so built-in defaults can also be audited.
- The analyzer must avoid double-counting: total suppressed is computed with the full profile, not by summing per-rule counts (rules can overlap).
- Performance: for typical TriOS logs (thousands of lines) and a handful of rules, this is fast enough. If it becomes slow later, cache results keyed by `(sources, profile)`.

### 4.3 UI changes

In `NoiseProfileSheet`:
- Add a new tab/section selector at the top: **Rules** | **Impact**.
- The **Impact** view shows:
  - Overall summary card: "Visible X lines | Suppressed Y lines | Z% noise reduction".
  - Per-rule rows: label, source scope chip(s), matched count, suppression percent, last-seen sample line (truncated), and a "Disable / Delete" action if the rule is custom.
  - Empty/stale state when a rule matches 0 lines: "No matches in current logs — rule may be stale".
  - Sort options: by matched count, by suppression percent, by label.
- The existing **Rules** tab stays unchanged (editor + suggestions + import/export).

Keep it inside the same sheet so users do not lose context.

### 4.4 Tests

Add to `tests/TriOSKitTests/LogsTabViewTests.swift`:
- `testImpactAnalyzerCountsTotalSuppressed` — overall suppression count equals noisy lines removed by the profile.
- `testImpactAnalyzerReportsPerRuleMatchedCount` — each rule's matched count reflects lines it alone would suppress (with defaults).
- `testImpactAnalyzerSourceScopedTotalLines` — source-scoped rule uses only its source's total for the percent denominator.
- `testImpactAnalyzerDetectsStaleRule` — rule that matches 0 lines reports `lastSeenSampleLine == nil`.
- `testImpactAnalyzerAvoidsDoubleCount` — two overlapping rules do not make total suppressed exceed total lines.

### 4.5 Verification gates

- `cargo run --bin clade-build`
- `cargo run --bin clade-e2e`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`
- `cargo run --bin clade-seal`
- `cargo test -p trios-mesh`
- `open trios.app` + menu-bar logo check

## 5. Roadmap handoff options for Cycle 54

1. **Rule expiration / TTL** — allow setting a duration on custom rules (e.g. "suppress for 24 hours") so temporary incident filters auto-disable; the impact dashboard becomes the trigger for "this rule has matched 0 lines for N days, disable it".  
2. **Encrypted / signed profile sharing** — encrypt exported profiles with the TriOS Keychain key and sign them so teams can share trusted runbook filters; the impact dashboard proves which rules are worth sharing.  
3. **Cross-source correlated incident markers** — parse known error/failure patterns and render vertical incident markers on the unified timeline so users can correlate noise spikes with real events.
