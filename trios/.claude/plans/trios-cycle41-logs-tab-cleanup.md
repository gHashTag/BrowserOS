# Cycle 41 Plan — LOGS Tab Cleanup: Deduplication, Filters, and Better UX

## 1. Weak spots investigated

The unified **LOGS** tab (Cmd+3) is currently a source of confusion rather than clarity:

1. **Dead "Next-loop variants" cards** — three hardcoded planning cards (preflight health check, persistent reliability scoring, multi-provider failover) from Cycle 11 still sit at the top of the tab. All three have long since been implemented or superseded, so they waste space and signal stale content.
2. **No duplicate suppression** — `.trinity/event_log.jsonl` contains thousands of near-identical `drift_detected` lines (same correlation ID, same event, only the elapsed-second counter changes). `browseros-companion.log` repeats `Reclaiming stale task leases` / `Failed to reclaim stale leases` every ~30 seconds. The viewer shows every line, burying unique events.
3. **Unstructured rendering** — JSONL event logs and pino-style companion logs are rendered as raw text, ignoring their embedded timestamps, levels, and event names.
4. **Naive severity coloring** — `lineColor` turns any line containing the substring "error" red, even if the word appears inside unrelated text.
5. **No filters or search** — users cannot hide `info` noise, search for a specific event, or filter by severity/source.
6. **Poor scannability** — full absolute paths are shown, no timestamps are surfaced from structured logs, and no per-source error counts are aggregated.
7. **No live-tail affordance** — refresh is manual; there is no indicator of how stale the view is.
8. **Reads entire files synchronously** — large files (e.g. 2 MB companion log) are loaded in one go without line caps or pagination.

## 2. Competitor / topic research

- **Gonzo (control-theory/gonzo, 2025)** — groups repeated messages with Drain3 pattern detection, color-codes severity, and streams live over WebSocket with pause/follow state.
- **logdelve (chassing/logdelve, 2026)** — anomaly baselines against a reference log, multi-pattern search, and one-key severity presets.
- **Xkeen-UI DevTools Log Viewer** — min-level threshold, token/chip filters, live/pause/follow state machine, and auto-scroll only when at the bottom.
- **minilog (SafirSDK/minilog, 2026)** — syslog-style viewer with infinite scroll, severity dropdowns, facility filters, and full-chain search.
- **DataViewer guide (2024/2025)** — recommends normalizing every log to a common record (`level`, `source`, `timestamp`, `message`, `raw`, `fields`), adding pattern grouping, and keeping filter state visible.

Consensus: normalize logs, collapse consecutive duplicates with a count badge, provide a min-level severity filter, add search, and keep the UI compact and scannable.

## 3. Decomposed plan

### 3.1 Remove dead content

1. Delete the hardcoded `cooperationOptions` / `optionCard` section from `LogsTabView`.
2. Replace it with a compact **Log insights** header showing:
   - Number of active sources
   - Total error/fatal and warning counts across all sources
   - Total duplicate groups collapsed
   - Last refresh timestamp and a live/stale indicator.

### 3.2 Structured log parsing

3. Introduce a normalized `ParsedLogLine` model with:
   - `rawLine`, `timestamp`, `level`, `sourceID`, `message`, `metadata`, `duplicateCount`.
4. Add a `LogLevel` enum (`trace=10`, `debug=20`, `info=30`, `warn=40`, `error=50`, `fatal=60`) with SwiftUI color and icon.
5. Parse `.trinity/event_log.jsonl` as JSONL: extract `timestamp`, `event`, `details`, `correlation_id`; map `drift_detected`, `watchdog_heartbeat`, `seal_audit`, `awareness_updated`, etc. to levels.
6. Parse pino-style JSON logs (`browseros-companion.log`, etc.): extract `level`, `time`, `msg`, `error`.
7. Parse plain-text logs (`cron.log`, `queen.log`, build logs): detect bracketed timestamps and keywords (`WARNING`, `WARN`, `ERROR`, `FATAL`, `failed`).
8. Keep a fallback raw parser for unrecognized formats so no log is dropped.

### 3.3 Deduplication

9. Within each source, collapse **consecutive** lines whose normalized message is identical into a single displayed row with a count badge (`×N`).
10. The normalized key ignores timestamps, PIDs, and uptime counters so repeated `drift_detected` and `Reclaiming stale task leases` lines group correctly.
11. Make deduplication toggleable in the UI so users can expand all rows when needed.

### 3.4 Filtering and search

12. Add a **min-level** filter chip set: All / Info / Warning / Error.
13. Add a **source filter** chip set so users can hide noisy sources (e.g. `browseros-companion.log`).
14. Add a search field that filters by substring across `message`, `event`, and `details`.
15. Persist filter state only in-memory for the current session (no UserDefaults complexity).

### 3.5 UX improvements

16. Render each log row with:
   - Severity badge (color-coded)
   - Timestamp (from structured logs when available, otherwise file order)
   - Source chip
   - Message text, colorized by level
   - Duplicate count badge when `duplicateCount > 1`
   - Monospaced text, selectable.
17. Show relative filenames in source cards instead of full absolute paths.
18. Add a per-source **Copy** button and a global **Copy filtered** button.
19. Add a **Clear search** button and an **Auto-refresh** toggle (manual default to avoid polling cost).
20. Cap each source to the last 500 lines during initial load to keep large files responsive; show a "+N older lines" hint if capped.

### 3.6 Safety / purity

21. All new identifiers must be ASCII-only English (L3 PURITY).
22. Log parsing must never crash the UI: invalid JSON lines fall back to raw text parsing.
23. Do not add new files on the critical build path; keep all changes inside `BR-OUTPUT/LogsTabView.swift` and add tests in `tests/TriOSKitTests/`.

### 3.7 Tests

24. Add `tests/TriOSKitTests/LogsTabViewTests.swift` covering:
   - `LogLevel` parsing from pino JSON.
   - JSONL event log parsing (timestamp, event, details, level).
   - Plain-text severity detection.
   - Consecutive duplicate grouping.
   - Search and severity filtering logic.

### 3.8 Verification

25. Run `TRIOS_SKIP_CHAT_E2E=1 ./build.sh`.
26. Run `cargo test -p trios-mesh`.
27. Run `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build`.
28. Run `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`.
29. Run `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal`.
30. Relaunch `trios.app` to preserve the menu-bar logo.
31. Write the report and three Cycle 42 options.

## 4. Files to change

- `trios/BR-OUTPUT/LogsTabView.swift` — full rewrite of the view with parsing, deduplication, filters, and improved UX.
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` (new) — unit tests for parsing and filtering.
- `trios/.claude/plans/trios-cycle41-logs-tab-cleanup.md` — this plan.
- `trios/.claude/plans/trios-cycle41-logs-tab-cleanup-report.md` — closure report.
- `trios/.trinity/experience/2026-07-27_logs-tab-cleanup-loop-041.json` — experience episode.

φ² + 1/φ² = 3 | TRINITY
