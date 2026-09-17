# Cycle 40 Report - Output-Budget Progress During Streaming

## Weak spots addressed

Cycle 39 completed the pre-send pin-aware guardrails, but once a stream started the user had **no live visibility into token consumption**:

1. **Sudden pause surprise**: `StreamingContextWatchdog` only surfaced a transient orange banner when the response crossed the warning ratio (80% output / 90% total). Until then, the streaming assistant message gave no hint that a pause was approaching.
2. **Hidden output ceiling**: The effective `maxOutputTokens` (advertised or learned-blended) was not shown while tokens were being emitted, so a user who requested a 4096-token budget on a model whose effective ceiling was 2048 only discovered the mismatch at pause time.
3. **No total-context meter**: As the response grew, the user could not see `input + output` approaching the usable context window (`maxContextTokens * margin`).
4. **Ephemeral, generic warning**: `streamingContextWarning` was a one-line orange banner with no progress ratio, no color band, and no model/ceiling name.

## Competitor patterns studied

- **ChatGPT / Claude web UI**: no live token meter; the response simply stops with a "Continue" button. Desktop clients also show no live budget.
- **Cursor composer**: shows a small "tokens used" counter while streaming and turns amber when >80% of the chosen model's context window; the counter sits inside the message footer.
- **GitHub Copilot chat**: renders a circular progress ring on long completions that fills toward the response cap; the ring turns red in the last 10%.
- **OpenRouter web UI**: displays `max_tokens` and an estimated consumption bar above the streaming response; color bands are green <50%, yellow 50-80%, red >80%.
- **Continue.dev / Lovable**: add a `TokenProgressView` inside each assistant message bubble showing `used / ceiling` with a segmented bar and a tooltip explaining which limit is being tracked.

Common pattern: a **compact, non-intrusive progress bar attached to the streaming UI** that updates with every delta and surfaces the approaching-limit state before the hard pause.

## Implementation summary

### Data layer

1. **Expose live watchdog token counts** — added `StreamingContextWatchdog.budgetRatios()` (`trios/rings/SR-00/StreamingContextWatchdog.swift:143`) returning `outputUsed`, `outputCeiling`, `totalUsed`, `totalCeiling`, `outputRatio`, and `totalRatio` against the active profile and margin.
2. **Publish a structured streaming-budget status** — defined `StreamingBudgetStatus` in `trios/rings/SR-01/ChatEvents.swift:74` with `outputUsed`, `outputCeiling`, `totalUsed`, `totalCeiling`, `outputRatio`, `totalRatio`, `kind` (`.safe`/`.warning`/`.critical`), and `limitKind` (`.outputTokens`/`.totalContext`).
3. **Update `feedWatchdog`** — `ChatViewModel.refreshStreamingBudgetStatus()` (`trios/rings/SR-02/ChatViewModel.swift:1857`) reads `budgetRatios()` after every SSE delta, chooses the dominant limit, classifies the ratio band, and assigns `@Published var streamingBudgetStatus` (`trios/rings/SR-02/ChatViewModel.swift:106`). The status is cleared on conversation switch, send start, cancel, new conversation, and every context-limit action handler.

### UI layer

4. **Add `streamingBudgetProgressBar`** — `ChatPanelView` (`trios/BR-OUTPUT/ChatPanelView.swift:1168`) renders a 4-pixel rounded bar, colored green/amber/red by `kind`, with a compact "used / ceiling" label that names the dominant limit ("output" or "context") and a tooltip showing both output and total-context breakdowns.
5. **Render in the composer** — the progress bar is shown inside `unifiedInputBar` (`trios/BR-OUTPUT/ChatPanelView.swift:507`) between the attachment notice and the warning banner, so it is visible as soon as a stream starts and disappears when the stream ends or is reset.

### Tests

6. **Watchdog unit tests** — `StreamingContextWatchdogTests.swift` gained `testBudgetRatiosNilBeforeStream` and `testBudgetRatiosReflectsOutputAndTotal` verifying the ratios and ceilings against the active profile and margin.
7. **View-model integration tests** — `StreamingContextWatchdogIntegrationTests.swift` gained `testStreamingBudgetStatusIsNilBeforeStream`, `testStreamingBudgetStatusPublishedDuringStream`, and `testStreamingBudgetStatusResetsOnNewConversation`, using the existing `MockPausingTransport` and `makeWatchdogTestViewModel` helpers.

## Files changed

- `trios/rings/SR-00/StreamingContextWatchdog.swift` — added `budgetRatios()`.
- `trios/rings/SR-01/ChatEvents.swift` — added `StreamingBudgetStatus` value type.
- `trios/rings/SR-02/ChatViewModel.swift` — added `@Published var streamingBudgetStatus`, `refreshStreamingBudgetStatus()`, and lifecycle resets.
- `trios/BR-OUTPUT/ChatPanelView.swift` — added `streamingBudgetProgressBar(_:)` and rendered it in `unifiedInputBar`.
- `trios/tests/TriOSKitTests/StreamingContextWatchdogTests.swift` — added `budgetRatios` coverage.
- `trios/tests/TriOSKitTests/StreamingContextWatchdogIntegrationTests.swift` — added `ChatViewModel` publication lifecycle coverage.
- `trios/.claude/plans/trios-cycle40-output-budget-progress-during-streaming.md` — Cycle 40 plan.
- `trios/.claude/plans/trios-cycle40-output-budget-progress-during-streaming-report.md` — this report.
- `trios/.trinity/experience/2026-07-27_output-budget-progress-during-streaming-loop-040.json` — experience episode.

## Tests

- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` PASS
- `cargo test -p trios-mesh` PASS (101 tests)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` PASS (0 hard-gate findings)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` SEAL VALID

`swift test` is unavailable in the CommandLineTools-only environment.

## Three Cycle 41 options

1. **Conversation-level learned-limit reset** — add a menu action to clear the learned context/output ceilings for the current conversation only, without resetting the global `StreamingContextLimitLearner` history. This is useful when a single thread hit a transient provider limit and the learned ceiling is now too conservative for that thread.
2. **Pin-aware draft context badge** — extend the composer draft utilization badge to explicitly read "Pinned model: X% of usable context" and show a pin icon, making it clear that the green/yellow/red bands are evaluated against the pinned `(provider, baseURL, model)` tuple rather than the global default.
3. **Stream health telemetry** — record per-stream output/total ceiling utilization as a lightweight outcome event so future model selection can prefer models with headroom for the user's typical requested budgets, and surface a "used X% of ceiling" summary in the Models tab reliability tooltip.

φ² + 1/φ² = 3 | TRINITY
