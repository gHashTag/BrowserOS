# Cycle 46 Plan — TriOS LOGS tab search history / recent queries

**Date:** 2026-07-24  
**Issue:** Closes #46  
**Ring:** SR-02 / BR-OUTPUT  
**Road:** B  
**Agent:** claude

## Weak spots researched

After five cycles the LOGS tab has structured parsing, live tail, scroll-aware follow, structured query DSL, and saved quick filters. Remaining UX gaps:

1. **Ad-hoc queries disappear** — a user types `level:warn source:cron timeout`, investigates, then has to retype the same string next time because only curated saved searches persist.
2. **Saved searches vs. throwaway searches** — saved searches are intentional favorites; most real-world log exploration is ephemeral and should be recallable without polluting the curated list.
3. **No keyboard/Enter affordance** — the search field currently records nothing on Enter, so there is no explicit "I ran this search" signal.
4. **No history hygiene** — without deduplication or a cap, history would grow forever and become noise.

## Competitor research

- **Datadog Log Explorer** retains the 100 most recent searches and suggests them while typing, alongside Saved Views capturing query + time range + facets. ([Search Logs](https://docs.datadoghq.com/logs/explorer/search.md), [Saved Views](https://docs.datadoghq.com/logs/explorer/saved_views.md))
- **Grafana Explore** stores query history for two weeks, allows starring queries for indefinite retention, and supports searching/filtering history by data source and date. ([Query management in Explore](https://grafana.com/docs/grafana/latest/visualizations/explore/query-management/))
- **Loki / Grafana Logs Drilldown** exposes quick positive/negative field filters from log details that mutate the query, plus deduplication and live-tail controls. ([View logs](https://grafana.com/docs/grafana/latest/visualizations/simplified-exploration/logs/view-logs/))

TriOS does not need multi-user sharing or NLQ yet; the immediate gap is local LRU history with a small, fast UI.

## Decomposition

### Task 1 — Data model and persistence
- Add `LogRecentSearch` struct to `LogParser.swift`.
- Add `LogRecentSearchStore` actor with `load`, `record(query:)`, `remove(id:)`, `clear`, max-count enforcement, and LRU deduplication.

### Task 2 — UI integration
- Add `@State private var recentSearches: [LogRecentSearch]` to `LogsTabView`.
- Add `recentSearchesBar` between `quickFiltersBar` and `filterBar`.
- Add `loadRecentSearches()`, `recordRecentSearch(query:)`, `removeRecentSearch(_:)`, `clearRecentSearches()` helpers.
- Wire search field `.onSubmit` and a 3-second debounce to record non-empty queries.
- Wire quick-filter taps to record their query as recent.
- Add context-menu actions: Apply, Remove, Save to quick filters.

### Task 3 — Tests
- Extend `LogsTabViewTests.swift` with tests for the store's empty/default state, record/dedupe/move-to-front, cap, remove, clear, and query application.

### Task 4 — Verification
- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e`
- Relaunch `open trios.app` and confirm menu-bar logo.

### Task 5 — Closure
- Write report at `.claude/plans/trios-cycle46-logs-tab-search-history-report.md`.
- Save episode at `.trinity/experience/2026-07-24_logs-tab-search-history-loop-046.json`.
- Update `.trinity/experience.md`.
- Update user memory file and `MEMORY.md` index.

## Three future options

1. **Time-range filtering** — add `from:`/`to:` query tokens or a date picker so recent searches and exports can be scoped to an incident window.
2. **Cross-source correlated timeline** — merge lines from all sources by `correlation_id` or timestamp into a single chronological trace view for incident correlation.
3. **True bottom-detection with GeometryReader** — replace the drag pause heuristic with actual content-offset math so scrolling back to bottom auto-resumes follow.
