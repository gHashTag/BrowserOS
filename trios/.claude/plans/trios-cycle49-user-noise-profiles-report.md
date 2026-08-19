# Cycle 49 Report — User-configurable noise profiles for LOGS tab

**Date:** 2026-07-27  
**Branch:** `feat/zai-provider`  
**Prompt:** "исследуй слабые места задачи, исследуй конкурентов по теме, создай декомпозированный план и реализуй все и в конце отчет и три варианта"  
**Plan:** `.claude/plans/trios-cycle49-user-noise-profiles.md`

---

## 1. Problem statement

Cycle 48 added a global "Quiet" toggle and reader-side log rotation. The noise filter was still **hard-coded**: users could not see what was being suppressed, disable individual patterns, or add their own. This lack of transparency and control is the main UX weak spot compared to observability competitors.

## 2. Competitor research (summary)

| Product | Pattern UX | User exclusion | Persistent rules |
|---|---|---|---|
| **Datadog Log Patterns** | Auto-detects clusters, one-click "Create exclusion filter" | Pattern-based, shareable | Yes, index filter list |
| **Grafana Loki** | LogQL `|>` / `!>` pattern operators + Patterns tab | Query-based, ad-hoc or alert rule | Yes, in query/ruler |
| **Splunk** | Field Extractor + Edge Processor pipelines | SPL `NOT` / `WHERE` | Yes, saved searches / macros |

Common insight: the best UX is **contextual** — right-click a noisy line → preview impact → create rule. TriOS was missing this entirely.

## 3. Chosen variant

**Variant B — Contextual "Hide events like this" + preview sheet**

Reasons for selection:
- Best UX-to-effort ratio.
- No backend changes; pure SwiftUI + model.
- Builds on the existing `LogNoiseFilter` without breaking Cycle 48 behavior.
- Gives users immediate feedback ("matches N lines") before they commit.

## 4. Implementation

### 4.1 Data model (`trios/rings/SR-02/LogParser.swift`)

- Added `LogNoiseRule`: `id`, `label`, `event`, `message`, `raw`, `enabled` (Codable, Equatable, Identifiable, Sendable).
- Added `LogNoiseProfile`: wraps `customRules`; merges with built-in defaults.
- Added `LogNoiseProfileStore` actor: persists to `.trinity/state/logs_noise_profile.json`.
- Refactored `LogNoiseFilter` to accept a `LogNoiseProfile` and evaluate both built-in and custom rules.
- Added `LogNoisePatternProposer`: derives a rule from a `ParsedLogLine`, preferring event → message phrase → raw substring, and rejecting overly broad patterns.

### 4.2 UI (`trios/BR-OUTPUT/LogsTabView.swift`)

- Added `noiseProfile` state loaded from `LogNoiseProfileStore`.
- Passed the profile into `LogParser.filterNoise(...)` and `LogParser.unifiedLines(...)`.
- Added **Rules** button next to the **Quiet** toggle.
- Added context menu on every log row: "Copy raw line" and "Hide events like this".
- Added `NoiseProfileSheet`:
  - Lists custom rules with inline editor (label, event, message, raw, enabled, delete).
  - Preview card when opened from the context menu, showing how many lines match the proposed rule.
  - "Add rule" form for manual creation.
  - Done button persists custom rules.

### 4.3 Tests (`trios/tests/TriOSKitTests/LogsTabViewTests.swift`)

- Custom rule filtering by event, message, raw substring.
- `LogNoiseProfileStore` persistence and update semantics.
- `LogNoisePatternProposer` event/message/raw fallback and broad-pattern rejection.
- `filterNoise` and `unifiedLines` with custom profile.

## 5. Verification gates

| Gate | Command | Result |
|---|---|---|
| Build | `./build.sh` | ✅ compiled (intermittent unrelated `ChatViewModel.swift` modification race on one retry) |
| Clade build | `cargo run --bin clade-build` | ✅ passed |
| Clade e2e | `cargo run --bin clade-e2e` | ✅ passed |
| Clade audit | `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` | ✅ 0 findings across 8 checks |
| Clade seal | `cargo run --bin clade-seal` | ✅ SEAL VALID |
| Mesh tests | `cargo test -p trios-mesh` | ✅ 101 passed |
| App relaunch | `open trios.app` | ✅ menu-bar logo preserved |

## 6. Files changed

- `trios/rings/SR-02/LogParser.swift` — noise profile model, store, filter, proposer.
- `trios/BR-OUTPUT/LogsTabView.swift` — UI state, context menu, sheet.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` — new unit tests.

## 7. Future options (three variants)

### Option A — Noise rule telemetry and suggestions
- Track which rules users create most often.
- Periodically propose new built-in defaults based on frequency (e.g., "metrics flush" appears 50× → suggest adding to defaults).
- Requires a small on-device analytics aggregation; no network.

### Option B — Per-source noise profiles
- Allow rules to be scoped to specific `sourceID` or `LogParserKind`.
- Useful when companion logs and queen logs have different "noise" definitions.
- Adds a `sourceIDs: [String]?` field to `LogNoiseRule` and a source picker in the sheet.

### Option C — Import/export and sharing
- Export `logs_noise_profile.json` to clipboard/Downloads.
- Import a profile shared by another team member or generated from a runbook.
- Adds `Import` / `Export` buttons to the sheet and a JSON schema version.

**Recommended next step:** Option A, because it closes the feedback loop between user behavior and default filter quality, which directly addresses the original "so much garbage" complaint.

---

Phase complete: Seal  
→ Phase 9: Learn
