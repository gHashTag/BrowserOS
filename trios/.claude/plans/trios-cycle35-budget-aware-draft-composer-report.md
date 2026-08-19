# Cycle 35 — Budget-Aware Draft Composer

## Ring
SR-00 / SR-02 / BR-OUTPUT

## Road
B — fix + test + experience save

## Problem
Cycle 34 gave each conversation its own pinned `requestedOutputTokens` and `contextWindowMargin`, but the composer still showed context impact only **after** the user pressed Send. A long draft could silently exceed the pinned margin, triggering unexpected history trimming or a `.tooLargeEvenEmpty` error at send time. The existing `contextUtilizationPercent` badge reflected the last sent request, not the current unsent draft, so there was no pre-send feedback.

## Root cause
`ChatViewModel` only published `contextUtilizationPercent` after `resolveContextRoutingDecision` ran during `sendMessage`. There was no cheap, synchronous estimate of the draft's impact against the current model's advertised window and the effective conversation margin. `ModelContextService.advertisedProfile` was private, and `ChatRequestSizer` had no helper for draft-only sizing.

## Fix
1. Made `ModelContextService.advertisedProfile(for:provider:)` public and `nonisolated` so the UI can read the advertised profile synchronously without blocking on learned-limit lookups.
2. Added `DraftContextStatus` to `ChatRequestSizer` and a static `draftContextUtilization(...)` helper that estimates `history + draft + systemPrompt` against `maxContextTokens * margin`. It reports `estimatedInputTokens`, `usableWindow`, `utilizationPercent`, `isTooLarge` (draft alone exceeds window), and `wouldTrimToFit`.
3. Added reactive `draftContextStatus`, `draftContextUtilizationPercent`, and `isDraftContextLimitExceeded` accessors to `ChatViewModel`.
4. Added a compact `composerDraftContextStatus` indicator in `ChatPanelView` next to the output-budget control, using the same green/yellow/red bands as the post-send badge. The help tooltip shows estimated tokens vs. usable window and whether history would be trimmed.
5. Disabled the send button when `isDraftContextLimitExceeded` is true, matching the routing "too large even empty" outcome.
6. Added unit tests for empty draft, small draft fit, too-large draft, history-trim warning, and margin clamping.

## Files
- `trios/rings/SR-00/ModelContextService.swift`
- `trios/rings/SR-00/ChatRequestSizer.swift`
- `trios/rings/SR-02/ChatViewModel.swift`
- `trios/BR-OUTPUT/ChatPanelView.swift`
- `trios/tests/TriOSKitTests/ChatRequestSizerTests.swift`
- `trios/.claude/plans/trios-cycle35-budget-aware-draft-composer.md`
- `trios/.claude/plans/trios-cycle35-budget-aware-draft-composer-report.md`
- `trios/.trinity/experience/2026-07-27_budget-aware-draft-composer-loop-035.json`

## Tests
- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` PASS
- `cargo test -p trios-mesh` PASS (101 tests)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` PASS (0 hard-gate findings)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` SEAL VALID
- `swift test` unavailable in CommandLineTools-only environment.

## Notes
- `trios.app` was rebuilt; the running app keeps the old binary until relaunched. Because the agent shell lacks Aqua/GUI access, run `open trios.app` from the user terminal to restore the menu-bar logo.
- `clade-e2e` was not run because the BrowserOS server (`127.0.0.1:9105/health`) is unavailable in this environment.

## Cycle 36 options
1. **Per-conversation model/provider pinning** — extend `ConversationSettings` with optional `provider/baseURL/model` so each thread remembers which model to use, and apply it on conversation switch without polluting the global default.
2. **Conversation-level learned-limit reset** — add an action to clear learned context/output ceilings for the current conversation only, without resetting the global `StreamingContextLimitLearner` history.
3. **Output-budget progress during streaming** — render a live progress indicator inside the streaming assistant message showing consumed output tokens vs. the effective budget/ceiling with color bands and approaching-limit warnings.
