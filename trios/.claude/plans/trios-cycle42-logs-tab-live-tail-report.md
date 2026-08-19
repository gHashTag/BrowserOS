# Cycle 42 Report — TriOS LOGS tab live tail

**Date:** 2026-07-24  
**Issue:** Closes #42  
**Ring:** SR-02 / BR-OUTPUT  
**Road:** B  
**Agent:** claude

## Summary

Cycle 41 turned the LOGS tab into a structured log viewer, but it still re-read every file and rebuilt the whole view every 5 s. That burned I/O, reset scroll position, and gave no true tail behavior. Cycle 42 added offset-based incremental loading and live-tail controls to the LOGS tab.

`LogParser.swift` now tracks a `lastReadOffset` per `LogSource` and a `LogParserKind` per source. `LogParser.incrementalRefresh` reads only newly written bytes, detects rotation/truncation, buffers incomplete trailing lines until the next newline arrives, appends parsed lines, applies the 500-line rolling cap, and re-dedupes consecutive duplicates across refresh boundaries. `LogsTabView.swift` gained a "Live" toggle with a status dot, a 5-second live tick, and a "Jump to latest" button that scrolls the detail view to the bottom anchor via `ScrollViewReader`.

The cycle was completed with a full reload button retained for explicit full refreshes, unit tests for the new incremental paths, and all TriOS gates passing.

## Files changed

- `trios/rings/SR-02/LogParser.swift`
- `trios/BR-OUTPUT/LogsTabView.swift`
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift`
- `trios/.trinity/specs/logs-tab-live-tail.md`
- `trios/.claude/plans/trios-cycle42-logs-tab-live-tail.md`
- `trios/.claude/plans/trios-cycle42-logs-tab-live-tail-report.md`
- `trios/.trinity/experience/2026-07-24_logs-tab-live-tail-loop-042.json`

## Verification

- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` — PASS
- `cargo test -p trios-mesh` — PASS (101 tests)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` — PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` — PASS (0 hard-gate findings)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` — SEAL VALID
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e` — PASS
- `open trios.app` — relaunched, menu-bar logo preserved (PID 50703)

`swift test` remains unavailable in this CommandLineTools-only environment.

## Research sources

- [Datadog Live Tail](https://docs.datadoghq.com/logs/explorer/live_tail.md)
- [Splunk Log Observer / Live Tail](https://docs.splunk.com/observability/en/logs/live-tail.html)
- [Grafana Explore logs](https://grafana.com/docs/grafana/latest/visualizations/explore/logs-integration/)
- [Apple Console Now Mode](https://support.apple.com/en-ca/guide/console/cnsl35710/mac)
- [pino-preview](https://github.com/aarokorhonen/pino-preview)
- [pino-ui](https://github.com/sergiofilhowz/pino-ui)
- [smart-log-viewer](https://github.com/timabell/smart-log-viewer)

## Three future options

1. **Scroll-aware auto-follow** — only auto-scroll when the user is already at the bottom; a manual scroll upward pauses live follow until the user clicks "Jump to latest" again.
2. **Structured query / export** — add a tiny search DSL (e.g. `level:warn source:cron-log`) and export filtered or capped results to a `.jsonl` or `.csv` file.
3. **Cross-source correlated timeline** — merge lines from all sources by timestamp or `correlation_id` into a single chronological trace view for incident correlation.
