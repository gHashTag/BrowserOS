# Cycle 44 Report — TriOS LOGS tab structured search and export

**Date:** 2026-07-24  
**Issue:** Closes #44  
**Ring:** SR-02 / BR-OUTPUT  
**Road:** B  
**Agent:** claude

## Summary

Cycle 43 made the LOGS tab live tail scroll-aware. The remaining weak spot was the search box: it only supported raw substring matching over message/event/details, with no way to filter by source, level, or event name, and no way to save a filtered view to disk. Cycle 44 added a lightweight structured query language and export.

`LogParser` now exposes `LogQueryToken` (level, source, event, free text) and `parseQuery(_:)`, `matchesQuery(_:tokens:source:)`, and `exportLines(_:to:)`. The search box accepts queries such as `level:error source:cron connection timeout`. Structured tokens are rendered as chips below the search field. The selected-log detail header gained an "Export" button that writes the currently visible (filtered and optionally deduplicated) rows to `~/Downloads/trios-logs-{sourceID}-{yyyyMMdd-HHmmss}.log` with a confirmation label.

## Files changed

- `trios/rings/SR-02/LogParser.swift`
- `trios/BR-OUTPUT/LogsTabView.swift`
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift`
- `trios/.trinity/specs/logs-tab-structured-search.md`
- `trios/.claude/plans/trios-cycle44-logs-tab-structured-search.md`
- `trios/.claude/plans/trios-cycle44-logs-tab-structured-search-report.md`
- `trios/.trinity/experience/2026-07-24_logs-tab-structured-search-loop-044.json`

## Verification

- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` — PASS
- `cargo test -p trios-mesh` — PASS (101 tests)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` — PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` — PASS (0 hard-gate findings)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` — SEAL VALID
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e` — PASS
- `open trios.app` — relaunched to fresh binary, menu-bar logo preserved (PID 8586)

`swift test` remains unavailable in this CommandLineTools-only environment.

## Research sources

- [Datadog Log Search Syntax](https://docs.datadoghq.com/logs/explorer/search_syntax/)
- [Grafana Loki LogQL](https://grafana.com/docs/loki/latest/query/)
- [Splunk Search Reference](https://docs.splunk.com/Documentation/Splunk/latest/SearchReference/Whatsinthismanual)
- [Kibana Query Language](https://www.elastic.co/guide/en/kibana/current/kuery-query.html)
- [pino-ui](https://github.com/sergiofilhowz/pino-ui)
- [smart-log-viewer](https://github.com/timabell/smart-log-viewer)

## Three future options

1. **True bottom-detection with GeometryReader** — replace the drag pause heuristic with actual content-offset math so scrolling back to the bottom automatically resumes follow.
2. **Cross-source correlated timeline** — merge lines from all sources by timestamp or `correlation_id` into a single chronological trace view for incident correlation.
3. **Saved searches / quick filters** — persist recent or named queries (e.g. "errors only", "cron warnings") and expose them as one-tap chips above the search box.
