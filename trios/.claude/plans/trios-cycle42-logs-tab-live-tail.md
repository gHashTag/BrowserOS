# Cycle 42 — TriOS LOGS tab live tail

## Research summary

### Competitors
- **Datadog Live Tail** — append-at-bottom, sampling under high load, active filters while streaming, clear best-effort messaging.
- **Grafana Explore / Loki** — Live/Pause/Resume/Stop/Clear controls, auto-scroll only when at bottom, jump-to-latest button, log-level colors, deduplication, row cap.
- **Splunk Log Observer** — play/pause, logs/second throttle, percentage-of-logs indicator, jump-to-recent.
- **macOS Console** — "Now Mode" keeps the live stream pinned to the newest message; Clear hides prior lines; Reload restores them.
- **pino-preview / pino-ui / smart-log-viewer** — stdin/WebSocket streaming, auto-follow when scrolled to bottom, pause/resume, source tagging, 2000-row in-memory cap.

### Common UX patterns
1. Controls: Live / Pause / Resume / Stop / Clear / Jump to latest.
2. Auto-scroll only while the user is already at the bottom; manual scroll freezes follow.
3. New rows are visually distinct; level colors preserved.
4. Filters/search stay active while streaming.
5. A row cap keeps UI memory bounded; older lines stay in the file.
6. Live tail is best-effort, not a replacement for indexed historical search.

## Weak spots in current Cycle 41 implementation

1. **Full reload on every tick.** `autoRefresh` calls `loadAll`, which re-reads every log file and replaces the whole `sources` array. This resets scroll position, discards user scroll state, and wastes disk I/O.
2. **No incremental offset tracking.** `LogParser` does not remember how much of each file has already been consumed, so it cannot append-only.
3. **No live/tail semantics.** The toggle is just "Auto" refresh. There is no pause/resume, no jump-to-latest, and no visual distinction for fresh lines.
4. **Unbounded growth risk.** Although the display window is capped at 500 lines, the refresh reads the entire file each time; a rapidly growing log causes repeated large reads.
5. **Boundary deduplication not tested.** Consecutive duplicates that span a refresh boundary are currently collapsed because the whole window is re-deduped, but once incremental append is implemented the boundary case must be handled explicitly.

## Decomposed plan

### 1. Spec (done)
- `.trinity/specs/logs-tab-live-tail.md` — invariants, canon files, success criteria.

### 2. LogParser incremental-refresh foundation
- Add `LogParserKind` enum (`eventLog`, `pinoJSON`, `plainText`) so each source knows which parser to use for newly arrived bytes.
- Add `lastReadOffset: UInt64` and `parser: LogParserKind` to `LogSource`.
- Add `LogParser.parser(for:)` helper.
- Update `parseSource` to record `parser` and `lastReadOffset` (file size after full read).
- Update `loadLogSources` to pass the correct parser kind per source.
- Implement `LogParser.incrementalRefresh(sources:maxLinesPerSource:)`:
  - Read current file size.
  - If unchanged, return source unchanged.
  - If smaller, reset offset to 0 and do a full re-read (log rotation/truncation).
  - If larger, read only the new bytes using `FileHandle`, split on line boundaries, parse with the source's parser.
  - Drop a trailing incomplete line and rewind the stored offset so it is consumed on the next refresh when the newline arrives.
  - Append new parsed raw lines, apply rolling cap, re-deduplicate, recompute counts.
  - Preserve `originalLineCount` from the full file line count.

### 3. LogsTabView live UI
- Rename "Auto" toggle to "Live" with a colored status dot.
- Add a "Jump to latest" button in the selected-log detail header.
- Wrap the inner log-line `ScrollView` in `ScrollViewReader` with a bottom anchor id (`"log-bottom"`).
- Change `loadAll` to do a full reload and select the first source if none selected.
- Add `tickLive()`:
  - Runs `LogParser.incrementalRefresh(sources: sources)` on a background queue.
  - Replaces `sources` while preserving `selectedSourceID` and hidden sources.
  - If `isLive` is true, scrolls the detail view to `"log-bottom"`.
- Replace `autoRefresh` task with a `liveTask` that calls `tickLive()` every 5 s.
- Keep manual reload button for a full refresh.

### 4. Tests
- `LogsTabViewTests.swift`:
  - `testIncrementalRefreshAppendsNewLines`
  - `testIncrementalRefreshDoesNothingWhenFileUnchanged`
  - `testIncrementalRefreshHandlesTruncation`
  - `testIncrementalRefreshDropsOldLinesAtCap`
  - `testIncrementalRefreshMergesDedupAcrossBoundary`

### 5. Verification gates
- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e` (may fail only on unavailable BrowserOS server)
- `open trios.app` to preserve the menu-bar logo.

### 6. Report + future options
- Report at `.claude/plans/trios-cycle42-logs-tab-live-tail-report.md`.
- Three future options at loop handoff.
- Experience episode at `.trinity/experience/2026-07-24_logs-tab-live-tail-loop-042.json` (or appropriate date; today is 2026-07-24 per context).
- Update `.trinity/experience.md` and user memory.

## Chosen road
**Road B** — standard spec-first implementation with tests and seal.

## Issue reference
Closes #42 (live-tail / incremental log viewer for TriOS LOGS tab).
