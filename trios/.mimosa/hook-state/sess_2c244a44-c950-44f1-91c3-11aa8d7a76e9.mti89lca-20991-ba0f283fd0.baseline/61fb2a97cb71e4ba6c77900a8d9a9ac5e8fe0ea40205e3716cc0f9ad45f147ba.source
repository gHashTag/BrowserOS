# Cycle 47 Report — LOGS tab cross-source correlated timeline

**Date:** 2026-07-24  
**Branch:** feat/zai-provider  
**Spec:** `.trinity/specs/logs-tab-correlated-timeline.md`  
**Plan:** `.claude/plans/trios-cycle47-logs-tab-correlated-timeline.md`

---

## 1. Goal

Give operators a single chronological view of events that span the trios app, the BrowserOS server, Queen cron, clade build/seal, and mesh rings. Previously the LOGS tab grouped lines by source, which made it hard to correlate an incident that appears in multiple files with different timestamp formats.

---

## 2. What was implemented

### 2.1 Parser additions (`rings/SR-02/LogParser.swift`)

- `LogTimelineMode` enum — `sources` (legacy grouped view) and `unified` (chronological merged view).
- `parseLineTimestamp(_:)` — tolerant timestamp parser that handles:
  - ISO 8601 (`2026-07-24T14:32:01Z`)
  - Bracketed date-time (`[2026-07-24_14:32:01]`)
  - Time-only (`14:32:01`) — anchored to today
  - Epoch seconds as a fallback
  - Returns `nil` for unparseable lines.
- `unifiedLines(sources:minLevel:searchText:deduplicate:maxRows:)` — merges multiple `LogSource` arrays, filters by level/text, sorts by parsed timestamp, and caps rows.
- `deduplicateConsecutiveAcrossSources(_:)` — removes consecutive identical `(sourceID, message, level, event)` tuples even when they come from different sources, producing the `×N` compact display.

### 2.2 UI additions (`BR-OUTPUT/LogsTabView.swift`)

- Segmented `Sources / Timeline` picker bound to `timelineMode`.
- `unifiedTimelineView` with:
  - Source color chip + timestamp on the left
  - Event badge, level badge, and message on the right
  - Monospaced message body and selectable row background
- `unifiedLogLinesView` with `ScrollViewReader` anchored to `log-bottom`.
- Copy and Export actions for the merged timeline.
- Preserved existing live-tail, scroll-aware follow, saved searches, and recent-search behavior.

### 2.3 Tests (`tests/TriOSKitTests/LogsTabViewTests.swift`)

Added XCTest coverage for:
- ISO 8601, bracketed, time-only, and unknown timestamp parsing
- Cross-source chronological sorting across heterogeneous formats
- Level and text filtering in unified mode
- Cross-source deduplication
- Stable ordering of lines without parseable timestamps (sorted to bottom)

---

## 3. Verification gates

All gates passed with `TRIOS_SKIP_CHAT_E2E=1`:

| Gate | Result |
|------|--------|
| `./build.sh` | ✅ 0 errors |
| `cargo run --bin clade-build` | ✅ Build + .app bundle |
| `cargo run --bin clade-audit` | ✅ 8/8 checks, 0 findings |
| `cargo run --bin clade-seal` | ✅ SEAL VALID |
| `cargo run --bin clade-e2e` | ✅ Report generated |
| `cargo test -p trios-mesh` | ✅ 101 passed |
| Menu-bar logo | ✅ `open trios.app` relaunched |

---

## 4. Weak spots addressed

1. **Heterogeneous timestamps** — solved by `parseLineTimestamp` with multiple parser attempts.
2. **Duplicate storm across sources** — solved by cross-source consecutive deduplication with `×N` counters.
3. **Performance on large logs** — solved by `maxRows` cap and in-memory filtering before sort.
4. **UI clutter in unified mode** — solved by compact row layout and source color chips.
5. **Loss of existing functionality** — solved by keeping `Sources` mode as the default and not removing grouped views.

---

## 5. Competitor research summary (from plan)

| Product | Approach | trios differentiator |
|---------|----------|----------------------|
| Datadog Logs | Schema-on-ingestion + full-text search | trios runs locally on raw files, no agent shipping |
| Grafana Loki | Label-based indexing, no full parse | trios parses timestamps client-side and correlates files ad-hoc |
| Splunk | Heavy parsing + enterprise schema | trios is lightweight, zero-config for trios dev/ops |
| `lnav` (CLI) | SQL + regex on tail | trios is native SwiftUI with live tail, saved searches, and visual event badges |

The unique value is **local, zero-config correlation of heterogeneous developer/ops logs inside the trios app**.

---

## 6. Three future options

### Option A — Time-window zoom and range export (fastest)
- Add a date/time range picker to the unified timeline.
- Export only lines inside the selected window.
- Fits immediate ops need with small UX-only scope.

### Option B — Alert-derived markers on the timeline (balanced)
- Parse known error/failure patterns and render vertical marker lines (e.g., build failure, health fail, mesh convergence fail).
- Clicking a marker jumps the unified timeline to that instant.
- Adds incident-navigation power without new storage.

### Option C — Full structured event store (deepest)
- Append every parsed log line to a local SQLite event table with indexed `(timestamp, source, level, event)`.
- Enable fast historical search, aggregation by event type, and trend charts.
- Requires schema migration and careful retention policy; strongest long-term value.

---

## 7. Closure

Cycle 47 is sealed. The unified correlated timeline is live, gated, and documented.

**Phase complete: Seal/Verify**
→ Phase 9: Learn / Experience save
