# Cycle 46 Report — TriOS LOGS tab search history / recent queries

**Date:** 2026-07-24  
**Issue:** Closes #46  
**Ring:** SR-02 / BR-OUTPUT  
**Road:** B  
**Agent:** claude

## Summary

Cycle 45 added curated saved searches / quick filters to the LOGS tab. The remaining weak spot was that ad-hoc structured queries disappeared between sessions — a user typing `level:warn source:cron timeout` had to retype it next time, and there was no Enter/commit affordance in the search field. Cycle 46 added local LRU search history as a separate, lighter-weight list.

`LogParser` now exposes `LogRecentSearch` (`id`, `query`, `timestamp`) and a `LogRecentSearchStore` actor that persists to `.trinity/state/logs_search_history.json` with a 20-entry cap, LRU deduplication (move-to-front), and empty-query filtering. `LogsTabView` gained a "Recent" chip row between quick filters and the search field. Tapping a chip applies the query; the context menu offers Apply, Remove from history, and Save to quick filters. A "Clear" button clears all history after confirmation. History is recorded on Enter (`.onSubmit`), when a saved-search quick filter is tapped, and after the query text has been stable for 3 seconds (debounce).

## Files changed

- `trios/rings/SR-02/LogParser.swift`
- `trios/BR-OUTPUT/LogsTabView.swift`
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift`
- `trios/.trinity/specs/logs-tab-search-history.md`
- `trios/.claude/plans/trios-cycle46-logs-tab-search-history.md`
- `trios/.claude/plans/trios-cycle46-logs-tab-search-history-report.md`
- `trios/.trinity/experience/2026-07-24_logs-tab-search-history-loop-046.json`

## Verification

- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` — PASS
- `cargo test -p trios-mesh` — PASS (101 tests)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` — PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` — PASS (0 hard-gate findings)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` — SEAL VALID
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e` — PASS
- `pkill -x trios; open trios.app` — relaunched to fresh binary, menu-bar logo preserved (PID 35331)

`swift test` remains unavailable in this CommandLineTools-only environment.

## Research sources

- [Datadog Log Explorer — Search Logs](https://docs.datadoghq.com/logs/explorer/search.md)
- [Datadog Log Explorer — Saved Views](https://docs.datadoghq.com/logs/explorer/saved_views.md)
- [Grafana Explore — Query management](https://grafana.com/docs/grafana/latest/visualizations/explore/query-management/)
- [Grafana Logs Drilldown — View logs](https://grafana.com/docs/grafana/latest/visualizations/simplified-exploration/logs/view-logs/)

## Three future options

1. **Time-range filtering** — add `from:`/`to:` query tokens or a date picker so recent searches and exports can be scoped to an incident window.
2. **Cross-source correlated timeline** — merge lines from all sources by `correlation_id` or timestamp into a single chronological trace view for incident correlation.
3. **True bottom-detection with GeometryReader** — replace the drag pause heuristic with actual content-offset math so scrolling back to bottom auto-resumes follow.
