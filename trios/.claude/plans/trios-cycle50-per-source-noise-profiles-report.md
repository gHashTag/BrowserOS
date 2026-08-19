# Cycle 50 Report — Per-Source Noise Profiles

**Issue:** gHashTag/trios#1084  
**Ring:** SR-02 / BR-OUTPUT  
**Road:** B (balanced)  
**Date:** 2026-07-27

## 1. Weak spot

Cycle 49 made noise rules user-editable, but every rule was **global**. A rule that suppressed `watchdog_heartbeat` or a companion health-check applied across **all** log sources. In practice the same pattern can be noise in one source and signal in another:

- `browseros-companion.log` — repetitive `health_check ok` is noise.
- `queen.log` — the same `health_check ok` may indicate an actual companion recovery event.
- `cron.log` — `drift_detected` heartbeat is noise.
- `event-log.jsonl` — the same event could be part of an incident trace.

Users needed metadata scoping in addition to the existing content pattern matching.

## 2. Competitor research

| Product | Per-source / per-stream scoping | UX pattern |
|---|---|---|
| **Datadog** | `log_processing_rules` live under a source/service entry; index exclusion filters use `source:`, `host:`, `service:` facets. | Scope rule by metadata, then define pattern. |
| **Grafana Loki** | Stream selector `{app="api", env="prod"}` combined with `!=` / `!~` pattern filters; Adaptive Logs drop rules include `stream_selector`. | Select streams first, silence pattern second. |
| **Splunk** | `props.conf` / `transforms.conf` stanzas keyed by `host::` and `source::`; macros can be scoped per detection. | Scope transform by host/source metadata. |

Common pattern: **metadata scoping + content pattern**. TriOS had the content layer but no metadata layer.

## 3. Chosen variant

**Road B — Add optional `sourceIDs` scope to `LogNoiseRule`, default global, contextual action pre-fills the source.**

Reasons:
- Backward-compatible: existing `.trinity/state/logs_noise_profile.json` decodes unchanged.
- No persistence format break, no new backend.
- Builds directly on Cycle 49 model, filter, store, and sheet.
- Small, reviewable diff.

## 4. Decomposition & implementation

### Data model

```swift
struct LogNoiseRule: Codable, Equatable, Identifiable, Sendable {
    let id: String
    var label: String
    var event: String?
    var message: String?
    var raw: String?
    var sourceIDs: [String]?   // nil / empty = global
    var enabled: Bool

    func applies(toSourceID sourceID: String) -> Bool {
        guard let ids = sourceIDs, !ids.isEmpty else { return true }
        return ids.contains(sourceID)
    }
}
```

### Filter behavior

`LogNoiseFilter.matches(rule:line:)` now rejects any line whose `sourceID` is outside the rule scope **before** checking `event` / `message` / `raw`:

```swift
guard rule.applies(toSourceID: line.sourceID) else { return false }
```

### Contextual rule derivation

`LogNoisePatternProposer.propose(from:sourceID:label:)` accepts the source of the row and returns a rule scoped to `[sourceID]`:

```swift
if let rule = LogNoisePatternProposer.propose(from: line, sourceID: line.sourceID) { ... }
```

### UI

- `NoiseProfileSheet` receives `availableSources: [LogSource]`.
- Rule editor shows source scope chips and a menu to toggle between **All sources** and selected source(s).
- Preview card renders the scope so the user sees what the rule will match before saving.

### Migration

Because `sourceIDs` is optional and omitted on encode when `nil`, existing profiles load unchanged and behave as global rules.

### Purity fix

T27 Verifier flagged non-ASCII glyphs in `BR-OUTPUT/LogsTabView.swift` (`·`, `×`, `—`). These were replaced with ASCII equivalents (`|`, `x`, `-`) so the file is ASCII-only.

## 5. Files changed

- `trios/rings/SR-02/LogParser.swift` — `LogNoiseRule.sourceIDs`, `applies(toSourceID:)`, scoped `LogNoiseFilter.matches`, scoped `LogNoisePatternProposer.propose`.
- `trios/BR-OUTPUT/LogsTabView.swift` — `NoiseProfileSheet.availableSources`, source scope editor, context menu source scoping, preview scope chips, ASCII-only cleanup.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` — source-scoped filter tests, global fallback, `applies` helper, proposer source prefill, legacy decoding, `filterNoise` scoping.
- `trios/.trinity/specs/per-source-noise-profiles.md` — spec + issue link.
- `trios/.claude/plans/trios-cycle50-per-source-noise-profiles.md` — plan + issue link.
- `trios/.claude/plans/trios-cycle50-per-source-noise-profiles-report.md` — this report.
- `trios/.trinity/experience/2026-07-27_logs-tab-per-source-noise-profiles-loop-050.json` — experience episode.

## 6. Verification gates

| Gate | Result |
|---|---|
| `cargo run --bin clade-build` | PASS |
| `cargo run --bin clade-e2e` | PASS (report `.trinity/e2e/report_prod_1785169019.md`) |
| `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` | PASS — 0 hard-gate findings across 8 checks |
| `cargo run --bin clade-seal` | SEAL VALID |
| `cargo test -p trios-mesh` | PASS — 101/101 tests |
| `open trios.app` | Relaunched, process present, menu-bar logo preserved |
| T27 Verifier (final) | **CLEAN** — L1-L7 all PASS |

## 7. Verdict

Cycle 50 is **CLEAN** and ready for land. The land commit must carry:

```
Closes gHashTag/trios#1084
```

## 8. Three future options

1. **Noise profile import/export and schema versioning** — add JSON Import/Export buttons to `NoiseProfileSheet` so users can share source-scoped profiles and runbooks can ship defaults. Include a `schemaVersion` field for safe migration.
2. **Per-source built-in presets and auto-suggest** — analyze per-source frequency patterns and propose new source-scoped rules automatically, closing the feedback loop between user edits and built-in defaults.
3. **Upstream / server-side noise reduction** — configure BrowserOS companion and Queen cron to emit high-frequency events at debug/sampled intervals, reducing disk I/O and archive churn before the LOGS tab ever sees them.
