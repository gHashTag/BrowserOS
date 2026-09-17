# Cycle 43 — TriOS LOGS tab scroll-aware live follow

## Research summary

### Competitors
- **Datadog Live Tail** — streaming auto-scrolls to the bottom; as soon as the user scrolls up, tailing pauses and a "Resume tailing" pill appears at the bottom of the stream.
- **Grafana Explore / Loki** — live mode only keeps the view pinned when the user is already near the bottom; a "Scroll to bottom" button appears after manual scroll.
- **Splunk Log Observer** — play/pause plus a "Jump to recent" button; manual interaction pauses the auto-follow playhead.
- **macOS Console** — "Now" mode auto-follows; user can scroll up to inspect history and the stream continues appending in the background.
- **pino-ui / smart-log-viewer** — auto-follow toggle that stops following on any scroll/drag and shows a resume control.

### Common UX patterns
1. Auto-follow is a separate state from live data ingestion.
2. Any deliberate scroll/drag by the user pauses auto-follow.
3. A visible resume control explains the paused state.
4. Explicit "Jump to latest" / "Resume" resumes follow.
5. Data keeps appending in the background; only the scroll position is frozen.

## Weak spots in current Cycle 42 implementation

1. **Forced scroll on every live tick.** `tickLive` increments `liveTick` unconditionally while `isLive` is true. If the user scrolled up to read a line, the next 5-second tick snaps the view back to the bottom and breaks reading flow.
2. **No paused-state UI.** The only way to stop the snapping is to turn Live off, which also loses the live indicator and stops the tick.
3. **No resume affordance.** After scrolling up there is no one-tap way to return to the bottom and resume follow; the user must click "Jump to latest" and then turn Live back on.
4. **Text selection is fragile.** Auto-scroll while the user is selecting/copying a line can cancel the selection.
5. **No hint near the live toggle.** The user cannot tell at a glance whether the detail pane is currently following or paused.

## Decomposed plan

### 1. Spec (done)
- `.trinity/specs/logs-tab-scroll-aware-follow.md`

### 2. State model
- Add `@State private var isFollowPaused: Bool = false` to `LogsTabView`.
- Add a small pure helper `shouldAutoScroll(isLive:isFollowPaused:) -> Bool` so the logic is unit-testable.

### 3. Scroll interaction detection
- Attach a `simultaneousGesture(DragGesture(minimumDistance: 5))` to the detail `ScrollView`.
- On `onChanged`, set `isFollowPaused = true`.
- Keep the gesture passive so the ScrollView still handles the actual scroll.

### 4. Follow-aware live tick
- In `tickLive`, only increment `liveTick` (and therefore scroll) when `isLive && !isFollowPaused`.
- Data still refreshes in the background regardless of pause state.

### 5. Resume control
- Add `resumeLiveFollow()` that sets `isFollowPaused = false` and increments `liveTick` to scroll to bottom.
- Add a floating pill overlay inside `logLinesView` that appears when `isLive && isFollowPaused`.
- Update "Jump to latest" to call `resumeLiveFollow()` instead of just incrementing `liveTick`.
- Add a subtle "Auto-scroll paused" label next to the live toggle when paused.

### 6. Tests
- `LogsTabViewTests.swift`:
  - `testShouldAutoScrollWhenLiveAndNotPaused`
  - `testShouldAutoScrollIsFalseWhenPaused`
  - `testShouldAutoScrollIsFalseWhenLiveOff`
  - `testPauseFollowStateCanBeToggled`

### 7. Verification gates
- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e`
- `open trios.app` to preserve the menu-bar logo.

### 8. Report + future options
- Report at `.claude/plans/trios-cycle43-logs-tab-scroll-aware-follow-report.md`.
- Three future options at loop handoff.
- Experience episode at `.trinity/experience/2026-07-24_logs-tab-scroll-aware-follow-loop-043.json`.
- Update `.trinity/experience.md` and user memory.
