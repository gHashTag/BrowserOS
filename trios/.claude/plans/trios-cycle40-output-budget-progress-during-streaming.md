# Cycle 40 Plan — Output-Budget Progress During Streaming

## 1. Weak spots investigated

After Cycle 39 the composer correctly disables send when a pinned model cannot fit the draft or the requested output budget, but **once a stream starts the user has no live visibility into token consumption**:

1. **Sudden pause surprise**: `StreamingContextWatchdog` only surfaces a transient banner when the response crosses the warning ratio (80% output / 90% total). Until then, the streaming assistant message gives no hint that a pause is approaching.
2. **No output-budget meter**: The effective output ceiling (learned-blended `maxOutputTokens`) is hidden during streaming. A user who requested a 4096-token budget on a model whose learned ceiling is 2048 will not know the mismatch until the watchdog pauses.
3. **No total-context meter**: `pendingEstimatedInputTokens` is fixed at stream start; as the response grows, the user cannot see `input + output` approaching the usable context window.
4. **Warning is ephemeral and generic**: `streamingContextWarning` is a one-line orange banner with no progress ratio, no color band, and no model/ceiling name.
5. **Action bar appears only after pause**: The "Continue on larger model / Summarize / Stop" actions are not available while approaching the limit, so the user cannot proactively choose a continuation strategy.

## 2. Competitor / topic research

- **ChatGPT / Claude web UI**: a thin progress indicator or token badge is not shown, but the response simply stops with a "Continue" button. Desktop clients show no live budget.
- **Cursor composer**: shows a small "tokens used" counter while streaming and turns amber when >80% of the chosen model's context window; the counter sits inside the message footer.
- **GitHub Copilot chat**: renders a circular progress ring on long completions that fills toward the response cap; the ring turns red in the last 10%.
- **OpenRouter web UI**: displays `max_tokens` and an estimated consumption bar above the streaming response; color bands are green <50%, yellow 50-80%, red >80%.
- **Continue.dev / Lovable**: add a `TokenProgressView` inside each assistant message bubble showing `used / ceiling` with a segmented bar and a tooltip explaining which limit (output vs context) is being tracked.

Common pattern: a **compact, non-intrusive progress bar attached to the streaming assistant message** that updates with every delta and pre-emptively surfaces the approaching-limit state.

## 3. Decomposed plan

### 3.1 Data layer

1. **Expose live watchdog token counts** — `StreamingContextWatchdog.estimatedTokens()` already returns `(input, output)`. Add a new method `budgetRatios() -> (outputRatio: Double, totalRatio: Double, outputUsed: Int, outputCeiling: Int, totalUsed: Int, totalCeiling: Int)` that returns current state against the active profile and margin.
2. **Publish a structured streaming-budget status** in `ChatViewModel`:
   - Add `@Published var streamingBudgetStatus: StreamingBudgetStatus?` that is set after every watchdog delta and cleared when the stream ends or is cancelled.
   - Define `StreamingBudgetStatus` struct with `outputUsed`, `outputCeiling`, `totalUsed`, `totalCeiling`, `outputRatio`, `totalRatio`, `kind` (`.safe`/`.warning`/`.critical`), and `limitKind` (`.outputTokens`/`.totalContext`).
3. **Update `feedWatchdog`** to compute the status from `contextWatchdog.budgetRatios()` and assign it to `streamingBudgetStatus`, so the UI re-renders on every delta.

### 3.2 UI layer

4. **Add a `StreamingBudgetProgressView`** in `BR-OUTPUT/ChatPanelView.swift` (or a new helper file) that renders:
   - A 4px-height rounded bar segmented into used/remaining portions.
   - Color band: green for `.safe`, amber for `.warning`, red for `.critical`.
   - A compact label: "1.2k / 4k output" or "12k / 16k context" depending on which ratio is higher (dominant limit).
   - A tooltip on hover showing both output and total-context breakdown plus the model name and effective ceiling.
5. **Render the progress view inside the streaming assistant message** in `unifiedMessageArea` / `assistantMessageView` only when `viewModel.streamingBudgetStatus` is non-nil and the last message is the assistant currently streaming.
6. **Upgrade the warning banner** so it includes the progress bar and a "Continue on larger model now" button when `canContinueOnLargerModel` is true and the status is `.warning`, giving the user a proactive escape before the hard pause.
7. **Keep the existing action bar** for the paused state unchanged.

### 3.3 Safety / purity

8. Ensure all new identifiers are ASCII-only and English (L3 PURITY).
9. Keep estimates cheap (`utf8.count / 4`) and never use them for billing.
10. Do not add new files on the critical build path beyond the existing Swift compilation list; if a helper file is added, include it in `build.sh` sources.

### 3.4 Tests

11. Extend `StreamingContextWatchdogTests.swift` with `testBudgetRatios()` proving the ratios and ceilings are reported correctly across ok/warning/pause states.
12. Add a lightweight `ChatViewModel` test (or extend an existing test) that verifies `streamingBudgetStatus` is populated after a `.textDelta` and nil after `endStream`/cancellation.

### 3.5 Verification

13. Run `TRIOS_SKIP_CHAT_E2E=1 ./build.sh`.
14. Run `cargo test -p trios-mesh`.
15. Run `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build`.
16. Run `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`.
17. Run `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal`.
18. Relaunch `trios.app` to preserve the menu-bar logo.
19. Write the report and three Cycle 41 options.

## 4. Files to change

- `trios/rings/SR-00/StreamingContextWatchdog.swift` — add `budgetRatios()` and `currentProfile` accessor.
- `trios/rings/SR-01/ChatEvents.swift` — add `StreamingBudgetStatus` enum/struct.
- `trios/rings/SR-02/ChatViewModel.swift` — publish `streamingBudgetStatus`, update `feedWatchdog`, clear status on stream end/cancel/switch.
- `trios/BR-OUTPUT/ChatPanelView.swift` — add `StreamingBudgetProgressView`, render it on the streaming assistant message, upgrade warning banner.
- `trios/tests/TriOSKitTests/StreamingContextWatchdogTests.swift` — add ratio tests.
- `trios/tests/TriOSKitTests/ChatViewModelStreamingBudgetTests.swift` (new) — verify status publication lifecycle.
- `trios/.claude/plans/trios-cycle40-output-budget-progress-during-streaming.md` — this plan.
- `trios/.claude/plans/trios-cycle40-output-budget-progress-during-streaming-report.md` — closure report.
- `trios/.trinity/experience/2026-07-27_output-budget-progress-during-streaming-loop-040.json` — experience episode.

φ² + 1/φ² = 3 | TRINITY
