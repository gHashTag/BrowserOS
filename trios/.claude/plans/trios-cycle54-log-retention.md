# Cycle 54 Plan - Log retention and artifact cleanup

## Three variants

### Variant A - UI-only filter (fastest)
- Change `LogParser.loadLogSources` to skip files matching artifact patterns.
- No new retention/cleanup logic.
- Risk: logs still accumulate on disk; user complaint returns.

### Variant B - Filter + retention (chosen)
- Categorize every `LogSource` as `.runtime`, `.service`, `.build`, `.test`, or `.artifact`.
- `loadLogSources` returns runtime + service by default; artifact logs available via explicit toggle.
- Add shell/Rust cleanup keeping 10 newest files per artifact family.
- Balanced: solves both UX and disk-growth concerns.

### Variant C - Centralized policy engine (deepest)
- Introduce `LogArtifactRetentionPolicy` Swift struct with per-family rules.
- Add JSON config under `.trinity/state/log_retention.json`.
- Background job enforces policy across runtime.
- Risk: larger change, more tests, needs T27 spec-first.

## Decomposition

1. **Spec** - write `.trinity/specs/log-retention-cycle54.md` and create GitHub issue #1087.
2. **Model** - add `LogSourceCategory` to `LogParser.swift`; classify by filename patterns.
3. **Reader** - update `loadLogSources` default behavior and add `includeArtifacts` flag.
4. **UI** - add artifact-log toggle in `LogsTabView.swift`; persist toggle preference.
5. **Scripts** - add cleanup blocks to `build.sh`, `run_chat_sse_e2e.sh`, `run_queen_autonomous_test.sh`.
6. **Rust** - add clade-build log cleanup in `clade-build/src/main.rs`.
7. **Tests** - XCTest coverage for classification and default filtering.
8. **Verify** - `clade-build`, `clade-audit`, `clade-e2e` (chat skipped), relaunch app.
9. **Report** - write `.claude/plans/trios-cycle54-log-retention-report.md`.
10. **Learn** - save `.trinity/experience/YYYY-MM-DD_log-retention-cycle54.json`.

## Issue

browseros-ai/BrowserOS#2046
