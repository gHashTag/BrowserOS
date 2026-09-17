# Cycle 38 Report - Pin-Aware Model Health Badge

## Weak spots addressed

Cycle 37 made warmup, routing, and failover respect a per-conversation `(provider, baseURL, model)` pin, but the **Models tab still presented global controls as if no pin existed**:

1. The active model section showed the global `store.selectedModel` without indicating that the current conversation was pinned to it.
2. The "Warm up now" button called `runAdaptiveWarmup()` unconstrained, which could switch the global default away from the pinned model and confuse the user.
3. The cross-provider failover section let the user enable the toggle and see global probe results with no hint that pinned conversations ignore cross-provider failover.
4. The custom-model "Use" button changed the global default without any indication that a pinned conversation would stay on its pin.

## Competitor patterns studied

- **ChatGPT / Claude desktop** surface the active model at the top of a conversation and lock the picker while a generation is in progress; pinned models are shown with a badge.
- **Cursor composer** displays a "pinned model" chip and re-labels provider/model switch actions that would leave the pinned thread.
- **GitHub Copilot chat** uses a "Using ..." badge in the model settings panel and suppresses global model changes for threads that have a pinned capability profile.
- **OpenRouter web UI** highlights the model row associated with a `session_id` and scopes warmup/failover controls to that model.

## Implementation summary

Injected the active `ChatViewModel` into `ModelsTabView` so the tab can read `conversationModelConstraint`. Added pin-aware view state and updated four surfaces:

1. **Active model badge** - subtitle now says "Pinned to this conversation: Provider / model" when a pin is active. A blue `pin.fill` capsule appears next to the provider name, and the pinned base URL is shown below the model row.
2. **Custom model hint** - when pinned, a note explains that changing the global default does not affect the pinned conversation.
3. **Constrained warmup** - "Warm up now" becomes "Warm up pinned model" and calls `runAdaptiveWarmup(constrainedTo: conversationModelConstraint)`, so it can never switch away from the pin. A help tooltip explains the behavior in both states.
4. **Cross-provider note** - when pinned, the failover section shows "Pinned conversations ignore cross-provider failover and stay on Provider / model."

Also fixed the pre-existing unused-result warning in the warmup button by replacing `let result =` with `_ =`.

## Files changed

- `trios/BR-OUTPUT/QueenTabView.swift` - passes `ChatViewModel` into `ModelsTabView`.
- `trios/BR-OUTPUT/ModelsTabView.swift` - receives `ChatViewModel`, adds pin-aware computed properties, badge, constrained warmup, and explanatory notes.
- `trios/.claude/plans/trios-cycle38-pin-aware-model-health-badge.md` - Cycle 38 plan.
- `trios/.claude/plans/trios-cycle38-pin-aware-model-health-badge-report.md` - this report.
- `trios/.trinity/experience/2026-07-27_pin-aware-model-health-badge-loop-038.json` - experience episode.

## Tests

- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` PASS
- `cargo test -p trios-mesh` PASS (101 tests)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` PASS (0 hard-gate findings)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` SEAL VALID

`swift test` is unavailable in the CommandLineTools-only environment. Chat integration tests are skipped because a pre-existing `memory database schema is version 4` assertion in the e2e harness fails in this environment.

## Three Cycle 39 options

1. **Conversation-level learned-limit reset** - add a menu action to clear the learned context/output ceilings for the current conversation only, without resetting the global `StreamingContextLimitLearner` history.
2. **Output-budget progress during streaming** - render a live progress indicator inside the streaming assistant message showing consumed output tokens vs. the effective budget/ceiling, with color bands and approaching-limit warnings.
3. **Pin-aware send-button guardrails** - when the draft exceeds the pinned model's context window or output ceiling, show a cause-specific disabled-state tooltip ("Pinned model cannot fit this draft") instead of the generic "too large" message, and offer a one-tap "Clear pin and send" escape hatch.
