# Spec — TriOS LOGS tab correlated timeline

**Cycle:** 47  
**Ring:** SR-02 / BR-OUTPUT  
**Road:** B  
**Closes:** #47

## Goal

Give the LOGS tab a unified, chronologically-correlated timeline view that merges lines from all visible log sources by timestamp, so a user can follow an incident across cron, event, queen, and companion logs without manually switching source cards.

## Invariants

- The existing **source-centric view** remains the default; the new view is an opt-in toggle.
- Search, min-level filter, deduplication, live tail, and export must work in both views.
- Unified view respects the current **source filter bar** (hidden sources are excluded).
- Timestamps are parsed from known formats; lines without a recoverable timestamp sort to the bottom and show a warning indicator.
- Lines rendered in unified view retain their source identity (icon, tint, display name) alongside the level icon.
- Live tail updates the unified view incrementally: only sources that changed are refreshed, then the merged list is re-sorted and filtered.

## Data model additions

```swift
enum LogTimelineMode: String, CaseIterable, Equatable, Sendable {
    case sources
    case unified
}
```

```swift
struct LogTimelineLine {
    let line: ParsedLogLine
    let source: LogSource
    let sortDate: Date
}
```

## Parser additions

- `LogParser.parseLineTimestamp(_:) -> Date?`
  - ISO 8601 (event logs).
  - `yyyy-MM-dd_HH:mm:ss` (plain text).
  - `HH:mm:ss` produced by `formatUnixSeconds`; anchor to today/yesterday heuristically.
  - Epoch seconds/milliseconds when available in metadata (future-proof).
- `LogParser.unifiedLines(
    sources: [LogSource],
    minLevel: LogLevel,
    searchText: String,
    deduplicate: Bool,
    maxRows: Int = 500
  ) -> [ParsedLogLine]`
  - Build `LogTimelineLine` for every line from non-hidden sources.
  - Apply level filter and structured query matcher.
  - Optionally collapse consecutive identical `(sourceID, message, level, event)` groups **across sources**.
  - Sort by `sortDate` ascending; stable tie-break by original source order for equal timestamps.
  - Return the last `maxRows` lines so the view shows the most recent activity.

## UX

- Segmented picker **Sources / Timeline** placed between the source cards and the detail/filter area.
- In **Sources** mode the existing source cards + selected-source detail pane are shown.
- In **Timeline** mode the detail pane is replaced by a single merged list with a header showing:
  - total merged rows,
  - number of sources included,
  - deduplication toggle,
  - export button (exports the visible merged rows).
- Each row in unified view shows:
  - source tint/icon badge on the left,
  - level icon/color,
  - timestamp,
  - message/event/details,
  - `×N` duplicate badge when deduplication is on.
- Rows without a parseable timestamp show a small `?` clock indicator and sort to the bottom.
- Tapping/clicking a row copies its raw line to the pasteboard (same as the Copy button in source view).

## Test criteria

- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` passes.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` passes.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` reports 0 hard-gate findings.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` is SEAL VALID.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e` passes.
- Unit tests cover:
  - ISO, bracketed, and time-only timestamp parsing.
  - Unified sort order across sources with different timestamp formats.
  - Min-level and search filtering in unified view.
  - Cross-source deduplication.
  - Lines with nil timestamps sort to the bottom.
- `open trios.app` relaunched to fresh binary; menu-bar logo preserved.
