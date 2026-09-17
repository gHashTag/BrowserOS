# Cycle 39 Report - Pin-Aware Send-Button Guardrails

## Weak spots addressed

Cycle 38 made the Models tab reflect a per-conversation `(provider, baseURL, model)` pin, but the **composer send button still behaved as if the global default were in charge**:

1. When the pinned model's advertised `maxContextTokens` could not fit the current draft, the send button was already disabled by `isDraftContextLimitExceeded`, but the tooltip did not name the pin or explain why the global default was not being used.
2. When the conversation's effective `requestedOutputTokens` exceeded the pinned model's `maxOutputTokens`, the user only discovered the mismatch at send time or via silent clamping, with no pre-send feedback.
3. The only escape was to open the Models tab, clear the pin, and return to the composer — a multi-step detour that broke the send flow.

## Competitor patterns studied

- **ChatGPT / Claude desktop** disable the send button when the selected model cannot fit the active context and surface the active model name in the disabled tooltip.
- **Cursor composer** shows a red "exceeds context" badge next to the model chip and offers a "Switch model" inline action that clears the per-file model binding.
- **GitHub Copilot chat** grays out the submit button when the pinned capability profile is incompatible and adds a one-click "Use default model" chip.
- **OpenRouter web UI** warns before send when the chosen model's context window or output ceiling is smaller than the request and provides an inline "Unpin model" shortcut.

## Implementation summary

Added two new view-model properties in `ChatViewModel` and wired them into `ChatPanelView`:

1. **Cause-specific pin tooltip** - `ChatViewModel.pinnedSendLimitReason` (`trios/rings/SR-02/ChatViewModel.swift:340`) checks the pinned model's advertised profile against the draft token estimate and the effective requested output budget. It returns a sentence that names the provider, model, and whether the context window, output ceiling, or both are exceeded.
2. **Send gating** - `ChatViewModel.isPinnedModelSendBlocked` (`trios/rings/SR-02/ChatViewModel.swift:366`) is true when `pinnedSendLimitReason` is non-nil. `ChatPanelView.sendButtonDisabled` (`trios/BR-OUTPUT/ChatPanelView.swift:1264`) now includes this flag, so the send button is disabled before the user wastes a request.
3. **Help text ordering** - `ChatPanelView.sendButtonHelpText` (`trios/BR-OUTPUT/ChatPanelView.swift:1255`) prefers the pin reason over the generic draft-limit message, so the tooltip explains *which* pinned tuple is blocking the send.
4. **One-tap escape hatch** - when the send is disabled by the pin, `ChatPanelView` renders a blue "Clear pin & send" capsule (`trios/BR-OUTPUT/ChatPanelView.swift:756`) that calls `viewModel.clearConversationModelOverride()` and immediately triggers `sendMessage()`. This keeps the user in the composer while removing the constraint.

The advertised-profile lookup uses the synchronous `ModelContextService.shared.advertisedProfile(for:provider:)`, so the disabled state updates live as the user types. The output-budget comparison uses the conversation override when set, otherwise the global `requestedOutputTokens`, matching the existing `effectiveConversationOutputTokens` semantics from Cycle 34.

## Files changed

- `trios/rings/SR-02/ChatViewModel.swift` - added `pinnedModelAdvertisedProfile`, `pinnedSendLimitReason`, `isPinnedModelSendBlocked`, and `formatCompact(_:)`.
- `trios/BR-OUTPUT/ChatPanelView.swift` - updated `sendButtonDisabled`, `sendButtonHelpText`, and added `isSendDisabledByPin` plus the "Clear pin & send" capsule.
- `trios/.claude/plans/trios-cycle39-pin-aware-send-button-guardrails.md` - Cycle 39 plan.
- `trios/.claude/plans/trios-cycle39-pin-aware-send-button-guardrails-report.md` - this report.
- `trios/.trinity/experience/2026-07-27_pin-aware-send-button-guardrails-loop-039.json` - experience episode.

## Tests

- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` PASS
- `cargo test -p trios-mesh` PASS (101 tests)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` PASS (0 hard-gate findings)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` SEAL VALID

`swift test` is unavailable in the CommandLineTools-only environment. Chat integration tests are skipped because a pre-existing `memory database schema is version 4` assertion in the e2e harness fails in this environment.

## Three Cycle 40 options

1. **Conversation-level learned-limit reset** - add a menu action to clear the learned context/output ceilings for the current conversation only, without resetting the global `StreamingContextLimitLearner` history. This is useful when a single thread hit a transient provider limit and the learned ceiling is now too conservative for that thread.
2. **Output-budget progress during streaming** - render a live progress indicator inside the streaming assistant message showing consumed output tokens vs. the effective budget/ceiling, with color bands and approaching-limit warnings, so the user sees why the watchdog paused before it happens.
3. **Pin-aware draft context badge** - extend the composer draft utilization badge to read "Pinned model: X% of usable context" and show a dedicated pin icon, making it explicit that the green/yellow/red bands are evaluated against the pinned tuple rather than the global default.
