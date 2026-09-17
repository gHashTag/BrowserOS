# Cycle 41 Report — LOGS Tab Cleanup (deduplication, structured parsing, better UX)

## Summary
The LOGS tab (Cmd+3) had become a dumping ground: stale "Next-loop variants" cards, unstructured raw log dumps, naive severity coloring, and thousands of duplicate `drift_detected` / pino error lines. This cycle removed the dead content, introduced format-aware parsing for JSONL event logs, pino JSON service logs, and plain-text cron/queen logs, collapsed consecutive duplicate messages with count badges, added severity/source/search filters, and improved the overall UX with an insights bar, source cards, and a clean log-detail panel.

## Files changed
- `trios/BR-OUTPUT/LogsTabView.swift` — rewritten SwiftUI view: insights bar, source cards, filter bar, dedup toggle, auto-refresh, searchable severity/source filters, clean log-detail panel.
- `trios/rings/SR-02/LogParser.swift` — new: `LogLevel`, `ParsedLogLine`, `LogSource`, and `LogParser` with format-aware parsers and consecutive-line deduplication.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` — new: unit tests for event-log, pino JSON, plain-text parsing, timestamp extraction, level inference, deduplication, source aggregation, and cap behavior.
- `trios/.claude/plans/trios-cycle41-logs-tab-cleanup.md` — decomposed plan.

## Verification
- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` — PASS
- `cargo test -p trios-mesh` — PASS (101 tests)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` — PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` — PASS (0 hard-gate findings)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` — SEAL VALID
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e` — PASS
- `open trios.app` — relaunched to preserve menu-bar logo invariant

## What was removed
- Hardcoded "Next-loop variants" cooperation cards (preflight health check, persistent reliability scoring, multi-provider failover) from `LogsTabView`.
- The old single raw-log view that only showed the last 120 lines with substring-based severity coloring.
- Duplicate noise: consecutive identical messages now collapse into a single row with a `×N` badge.

## What was added
- **Format-aware parsing**:
  - `event_log.jsonl` — parses `timestamp`, `event`, `details`, `correlation_id`; maps `drift`/`error`/`fail`/`heartbeat` to severity.
  - `browseros-companion.log` and other pino JSON logs — parses numeric `level`, `time`, `msg`, `error`.
  - Plain-text logs (`cron.log`, `queen.log`, etc.) — extracts `[YYYY-MM-DD_HH:MM:SS]` or `[epoch]` timestamps and infers severity from keywords.
- **Consecutive deduplication** with `×N` count badges and a per-source toggle to view raw lines.
- **Insights bar**: source count, errors, warnings, duplicate groups, capped-file indicator.
- **Source filter bar**: toggle visibility per log source with inline error badges.
- **Source cards**: one card per source showing name, error/warning counts, row count, and cap indicator; selecting a card opens the detail panel.
- **Filter bar**: search across message/event/details, severity chips (INFO/WARN/ERROR/FATAL), dedup toggle.
- **Log detail panel**: color-coded rows, timestamps, event labels, duplicate count badges, details, copy-to-clipboard, and a cap notice when a file exceeds 500 lines.
- **Auto-refresh**: optional 5-second polling while the tab is visible.

## Design decisions
- Kept the parser in `rings/SR-02/LogParser.swift` (Foundation-only, no SwiftUI) so it is covered by the TriOSKit SPM target and testable from `TriOSKitTests`.
- Kept the SwiftUI view in `BR-OUTPUT/LogsTabView.swift` as the canonical UI artifact.
- Used ASCII-only identifiers throughout (L3 PURITY).
- Capped each source at 500 lines to keep UI responsive; older lines remain in the file and can be copied from disk.
- Renamed the local flow-layout helper to `LogsFlowLayout` to avoid collision with the existing `FlowLayout` in `MeshTabView.swift`.

## Known limitations / next cycle options
1. **Streaming / tail behavior** — currently the view reloads the whole file; for very active logs, add a streaming tail that appends new lines without rebuilding the entire LazyVStack.
2. **Structured export / log query language** — add a small query DSL (e.g., `level:warn source:cron-log`) and export filtered results to a file.
3. **Cross-source correlation** — merge logs from all sources into a single chronological timeline using `correlation_id` or approximate timestamps, so a user can trace an event across cron, queen, and service logs in one view.
