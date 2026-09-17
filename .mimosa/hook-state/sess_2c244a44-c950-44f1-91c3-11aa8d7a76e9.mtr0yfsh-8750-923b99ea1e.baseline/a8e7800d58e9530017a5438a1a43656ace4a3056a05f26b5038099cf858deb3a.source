# Cycle 47 Plan — TriOS LOGS tab correlated timeline

**Date:** 2026-07-24  
**Issue:** Closes #47  
**Ring:** SR-02 / BR-OUTPUT  
**Road:** B  
**Agent:** claude

## Weak spots researched

After six cycles the LOGS tab can parse multiple log formats, live-tail, scroll-follow, search with a structured DSL, save quick filters, and keep recent-query history. The remaining structural gap is **cross-source incident correlation**:

1. **Sources are silos.** cron-log, event-log, queen-log, and companion logs are separate cards. A failure often appears first in cron, then in event logs, then in queen logs; the user must click each source and mentally align timestamps.
2. **Timestamps differ by format.** Event logs use ISO 8601, pino JSON uses epoch seconds rendered as `HH:mm:ss`, and plain text uses `yyyy-MM-dd_HH:mm:ss`. They cannot be sorted as raw strings.
3. **correlation_id exists but is invisible.** Event logs carry `correlation_id`, but there is no UI that groups or highlights related lines.
4. **Dedup is per-source.** A message emitted by two services appears twice in the current UI.

## Competitor research

- **Datadog** correlates APM traces and logs by injecting `trace_id`, `span_id`, `env`, `service`, `version` into log attributes, and provides a Logs tab inside a Trace view and a Trace tab inside Log Explorer. Cross-product correlation unifies app logs, proxy logs, DB logs, RUM, and synthetic tests. ([Correlate Logs and Traces](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces.md), [Cross-Product Correlation](https://docs.datadoghq.com/logs/guide/ease-troubleshooting-with-cross-product-correlation.md))
- **Grafana Tempo ↔ Loki** correlates traces and logs via `trace_id`/`span_id`, with time-shift to handle clock skew, and supports the same for Splunk through data-source plugins. ([Trace to logs](https://grafana.com/docs/grafana/next/datasources/tempo/configure-tempo-data-source/configure-trace-to-logs/))
- **Splunk** provides `transaction` and `stats` commands for request/session correlation, and data links to jump from parsed trace IDs to tracing backends.

TriOS does not have distributed tracing yet, but it does have multiple local log sources with timestamps and an emerging `correlation_id`. The immediate value is a unified chronological timeline, with correlation_id grouping as a future layer.

## Decomposition

### Task 1 — Timestamp parsing
- Add `LogParser.parseLineTimestamp(_:)` that returns `Date?` for:
  - ISO 8601 (`yyyy-MM-dd'T'HH:mm:ss`)
  - Bracketed plain-text format (`yyyy-MM-dd_HH:mm:ss`)
  - Time-only `HH:mm:ss` (anchor to today/yesterday heuristically)
- Add tests for each format and for nil/unparseable input.

### Task 2 — Unified line builder
- Add `LogParser.unifiedLines(sources:minLevel:searchText:deduplicate:maxRows:)`.
- Build `(line, source, sortDate)` tuples for all visible sources.
- Apply level and query filters using existing `matchesQuery`.
- Sort ascending by `sortDate`; missing timestamps sort to the bottom with stable tie-break.
- Optional cross-source deduplication: collapse consecutive identical `(sourceID, level, event, message)`.
- Return the last `maxRows` lines so the view stays recent.

### Task 3 — UI mode switch
- Add `@State private var timelineMode: LogTimelineMode = .sources` to `LogsTabView`.
- Add a segmented picker between source cards and the detail/filter area.
- Keep the existing source-detail view for `.sources` mode.
- Add `unifiedTimelineView` for `.unified` mode with a header (row count, source count, dedup toggle, export) and a single merged `LazyVStack`.
- Each row shows source tint/icon badge + level icon + timestamp + message/event/details + duplicate badge.
- Row tap copies raw line to pasteboard.

### Task 4 — Live tail integration
- In unified mode, `tickLive()` and `loadAll()` must rebuild the unified view from refreshed sources.
- Because sources refresh independently, the unified list is re-sorted and re-filtered after every live tick.

### Task 5 — Tests
- Extend `LogsTabViewTests.swift` with:
  - Timestamp parsing for ISO, bracketed, time-only, and nil cases.
  - Unified sort order across mixed timestamp formats.
  - Unified level/query filtering.
  - Cross-source deduplication.
  - Missing-timestamp ordering.

### Task 6 — Verification
- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e`
- Relaunch `open trios.app` and confirm menu-bar logo.

### Task 7 — Closure
- Write report at `.claude/plans/trios-cycle47-logs-tab-correlated-timeline-report.md`.
- Save episode at `.trinity/experience/2026-07-24_logs-tab-correlated-timeline-loop-047.json`.
- Update `.trinity/experience.md`.
- Update user memory file and `MEMORY.md` index.

## Three future options

1. **correlation_id grouping** — detect shared `correlation_id` across sources and render collapsible incident groups with a group-level count and first/last timestamp.
2. **Time-range filtering** — add `from:`/`to:` query tokens or a date picker so the unified timeline can focus on an incident window.
3. **True bottom-detection with GeometryReader** — replace the drag pause heuristic with actual content-offset math so scrolling back to bottom auto-resumes follow.
