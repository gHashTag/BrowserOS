# Cycle 39 Plan - Pin-Aware Send-Button Guardrails

## Weak spots

Cycle 37/38 made per-conversation model pins constrain warmup, failover, routing, and the Models tab UI, but the **composer send button still gives a generic refusal when the pinned model cannot fit the draft**:

1. `isDraftContextLimitExceeded` only knows "draft exceeds usable context window". It does not distinguish whether the draft is too large for the **pinned model specifically** or for the global default, so the disabled tooltip is not actionable.
2. There is no output-budget check in the composer. A pinned model may fit the context but cannot honor the conversation's requested output budget, yet the user can press Send and only later hit clamping or `.tooLargeEvenEmpty`.
3. When a pinned model cannot fit, the only escape is to open the Models tab, clear the pin, and retry. There is no one-tap action attached to the disabled send state.
4. The utilization badge shows a percentage, but it does not name the pinned model or its ceiling, so users do not connect the limit to the pin.

## Competitor patterns

- **Claude iOS/macOS** disables the send button with a contextual message naming the active model ("Claude 3.5 Sonnet cannot process files this large") and offers a "Switch model" shortcut.
- **ChatGPT** shows "This model has a maximum context length" and a model-picker menu on the same disabled surface.
- **Cursor** dims the submit button with a tooltip "Current model does not support context > N tokens" and a "Use larger model" one-tap escape that clears the composer-level model preference.
- **Gemini app** shows a "Long context required" chip and a "Try with 1.5 Pro" button, preserving the user's intent while surfacing the constraint.

## Decomposition

1. **Compute pin-specific draft status** - add `ChatViewModel.pinnedDraftContextStatus` and `isPinnedModelDraftLimitExceeded` that evaluate the draft against the pinned model's advertised profile (not the global default).
2. **Output-budget check** - add `ChatViewModel.isPinnedOutputBudgetExceeded` that compares the effective requested output budget against the pinned model's `maxOutputTokens` and is disabled if the pinned model cannot honor it.
3. **Cause label** - expose `ChatViewModel.pinnedSendLimitReason` returning a structured reason: `.ok`, `.contextWindow(model:provider:limit)`, `.outputBudget(requested:limit)`, `.both(...)`.
4. **UI: send button help** - update `ChatPanelView.sendButtonHelpText` to show cause-specific messages when pinned and limited, e.g. "Pinned to Anthropic / claude-sonnet-4-5: draft exceeds 128k context window" or "requested 8192 output tokens exceeds pinned model ceiling of 4096".
5. **UI: escape hatch** - add a small secondary action near the disabled send button: "Clear pin and send". This asynchronously clears the conversation model override and re-triggers `triggerSend()` so the global default/routing can handle the draft.
6. **Composer status help** - update `composerStatusHelp` to mention the pinned model limit when applicable.
7. **Tests & gates** - build, clade-build, clade-audit, clade-seal, trios-mesh tests. Add unit tests in `ChatRequestSizerTests` or `ModelConfigurationStoreCrossProviderTests` if needed; otherwise rely on compilation gates.
8. **Report & options** - write the Cycle 39 report with three Cycle 40 options.

## Exit criteria

- Send button shows a cause-specific disabled tooltip naming the pinned model and the exact limit.
- A "Clear pin and send" escape hatch is visible when the send is disabled due to a pinned-model limit.
- Clearing the pin sends the message against the global default (with normal warmup/routing).
- All Trinity gates pass with `TRIOS_SKIP_CHAT_E2E=1`.
