# Cycle 43 Spec — TriOS LOGS tab scroll-aware live follow

## Goal

Make the LOGS tab live tail respect the user's scroll intent. When the user scrolls up to inspect history, auto-follow pauses and a floating "Resume live" control appears. Scrolling back to the bottom (or clicking the control) resumes auto-follow. This fixes the UX regression introduced by Cycle 42, where every live tick snapped the view to the bottom regardless of user interaction.

## Invariants

- The detail view must still scroll to the bottom on initial load and on explicit "Jump to latest".
- Live data must keep appending while the toggle is on; only the scroll behavior pauses.
- A visible control must explain why follow is paused and how to resume.
- Existing filters, deduplication, and level selection remain active while follow is paused.

## UX

- Live toggle stays as-is.
- When `Live` is on and the user interacts with the log detail scroll area, auto-follow pauses.
- A floating pill/button appears inside the detail pane: `Live paused — Resume`.
- Clicking the pill resumes follow and scrolls to the latest line.
- Clicking "Jump to latest" also resumes follow.
- A small hint near the live toggle can say "Auto-scroll paused" while paused.

## Architecture

- Add `@State private var isFollowPaused: Bool` to `LogsTabView`.
- Detect manual scroll via a `simultaneousGesture(DragGesture())` on the detail `ScrollView`.
- In `tickLive`, only increment `liveTick` (which triggers `scrollTo("log-bottom")`) when `isLive && !isFollowPaused`.
- Add `resumeLiveFollow()` that clears `isFollowPaused` and scrolls to bottom.
- Add a floating resume control overlay on `logLinesView`.

## Test criteria

- `LogsTabViewTests`:
  - `testScrollPauseStateDefaultsToFalse`
  - `testScrollPauseCanBeSetAndCleared`
  - `testResumeFollowScrollsToBottom`
  - `testLiveTickDoesNotScrollWhenFollowPaused`

Because SwiftUI ScrollView drag/geometry state is hard to unit-test, extract a small pure helper `shouldAutoScroll(isLive:isFollowPaused:)` and test that.

## Canon files

- `trios/BR-OUTPUT/LogsTabView.swift` (view changes)
- `trios/tests/TriOSKitTests/LogsTabViewTests.swift` (state tests)

## Verification gates

- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal`
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e`
- `open trios.app` to preserve the menu-bar logo.
