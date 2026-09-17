# Spec — TriOS LOGS tab live tail (Cycle 42)

## Goal
Turn the TriOS LOGS tab (Cmd+3) from a periodic full-reload viewer into an incremental, live-tail viewer that appends new log lines as they arrive, keeps the view pinned to the latest entry when "Live" is on, and never loses the user's scroll position or filters.

## Motivation
Cycle 41 cleaned up the LOGS tab: format-aware parsing, deduplication, severity/source/search filters, and a 500-line cap. The remaining weak spot is the refresh model: every 5 seconds the view reads every log file from scratch, rebuilds the source list, and resets the scroll. For active services this causes the log detail to jump away from the line the user is reading, wastes I/O, and hides newly arrived lines until the next whole-page rebuild. Competitors (Datadog Live Tail, Grafana Explore, macOS Console Now Mode, pino-preview) solve this with incremental append, pause/resume, and bottom-follow behavior.

## Invariants

1. **INV-1 — Offset tracking.** Each `LogSource` records the byte offset of the last fully consumed line in its backing file.
2. **INV-2 — Incremental read.** A refresh reads only the bytes appended since the recorded offset. If the file shrank (rotation/truncation), the source resets and re-reads from offset 0.
3. **INV-3 — Rolling cap.** New lines are appended to the in-memory window; if the window exceeds `maxLinesPerSource`, the oldest lines are discarded. The cap notice remains accurate.
4. **INV-4 — Boundary-safe deduplication.** Consecutive duplicate detection must merge the last previously deduplicated line with the first newly arrived line when they match.
5. **INV-5 — Live mode.** A "Live" toggle schedules incremental refreshes. While live, the detail view auto-scrolls to the newest line. Turning live off freezes the stream so the user can inspect history without fighting the scroll.
6. **INV-6 — Stable identity.** Source IDs and user selections/filters survive incremental refreshes.
7. **INV-7 — Verification.** Change must pass `./build.sh`, `cargo run --bin clade-build`, `cargo run --bin clade-audit`, `cargo run --bin clade-seal`, and `cargo run --bin clade-e2e` (server availability permitting).

## Canon files
- `rings/SR-02/LogParser.swift` — parser and incremental-refresh logic.
- `BR-OUTPUT/LogsTabView.swift` — live UI, auto-scroll, and controls.
- `tests/TriOSKitTests/LogsTabViewTests.swift` — unit tests for incremental refresh and live-tail edge cases.

## UI sketch
```
[LOGS]                    [Live ●] [Reload] [Jump to latest]
Runtime logs...
────────────────────────────────────────────────────────────
sources | errors | warnings | dup groups | capped
[source chips]
[source cards]
[search] [INFO] [WARN] [ERROR] [FATAL] [Dedup]
┌─────────────────────────────────────────────────────────┐
│ cron.log — 312 / 500 rows                    [Copy]     │
│                                                         │
│ 14:02:10  INFO  started                                 │
│ 14:02:11  WARN  drift_detected ×3                       │
│ 14:02:12  ERROR connection refused                      │
│                      <-- pinned to bottom when Live     │
└─────────────────────────────────────────────────────────┘
```

## Scope limits for this cycle
- No server-side WebSocket streaming; live tail is implemented by polling files on a short interval (5 s).
- No new log formats.
- No cross-source correlation or query DSL (future options).
- No persistent user preferences across app launches (future option).

## Success criteria
- `./build.sh` passes with no new warnings caused by this change.
- `LogParser.incrementalRefresh` appends only new lines and updates offsets.
- Rotated/truncated files are detected and fully re-read.
- `LogsTabView` keeps filters/selection stable across live ticks.
- `LogsTabViewTests` covers append, truncation, cap, and boundary deduplication.
- `clade-seal` reports `VALID`.
- `trios.app` is relaunched after build to preserve the menu-bar logo invariant.
