# Cycle 43 Report — TriOS LOGS tab scroll-aware live follow

**Date:** 2026-07-24  
**Issue:** Closes #43  
**Ring:** SR-02 / BR-OUTPUT  
**Road:** B  
**Agent:** claude

## Summary

Cycle 42 added live tail to the LOGS tab, but every 5-second tick snapped the detail view back to the bottom even when the user had scrolled up to inspect history. Cycle 43 introduced scroll-aware auto-follow: any drag/scroll inside the detail pane pauses auto-follow, data keeps appending in the background, and a floating "Resume live" pill appears. Clicking the pill or "Jump to latest" resumes follow and scrolls to the latest line.

`LogsTabScrollPolicy.shouldAutoScroll(isLive:isFollowPaused:)` centralizes the decision so it is unit-testable. `LogsTabView` gained `@State private var isFollowPaused`, a drag gesture on the detail `ScrollView`, follow-aware logic in `tickLive` and `loadAll`, a floating resume control overlay, and an orange "paused" indicator next to the live toggle.

## Files changed

- `trios/rings/SR-02/LogParser.swift`
- `trios/BR-OUTPUT/LogsTabView.swift`
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift`
- `trios/.trinity/specs/logs-tab-scroll-aware-follow.md`
- `trios/.claude/plans/trios-cycle43-logs-tab-scroll-aware-follow.md`
- `trios/.claude/plans/trios-cycle43-logs-tab-scroll-aware-follow-report.md`
- `trios/.trinity/experience/2026-07-24_logs-tab-scroll-aware-follow-loop-043.json`

## Verification

- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` — PASS
- `cargo test -p trios-mesh` — PASS (101 tests)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` — PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` — PASS (0 hard-gate findings)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` — SEAL VALID
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e` — PASS
- `open trios.app` — relaunched to fresh binary, menu-bar logo preserved (PID 86751)

`swift test` remains unavailable in this CommandLineTools-only environment.

## Research sources

- [Datadog Live Tail](https://docs.datadoghq.com/logs/explorer/live_tail.md)
- [Grafana Explore logs](https://grafana.com/docs/grafana/latest/visualizations/explore/logs-integration/)
- [Splunk Log Observer / Live Tail](https://docs.splunk.com/observability/en/logs/live-tail.html)
- [Apple Console Now Mode](https://support.apple.com/en-ca/guide/console/cnsl35710/mac)
- [pino-ui](https://github.com/sergiofilhowz/pino-ui)
- [smart-log-viewer](https://github.com/timabell/smart-log-viewer)

## Three future options

1. **True bottom-detection with GeometryReader** — replace the drag pause heuristic with actual content-offset math so scrolling back to the bottom automatically resumes follow without an explicit click.
2. **Structured query and export** — add a tiny search DSL (e.g. `level:warn source:cron-log`) and an export button to save filtered results to JSONL/CSV.
3. **Cross-source correlated timeline** — merge lines from all sources by timestamp or `correlation_id` into a single chronological trace view for incident correlation.
