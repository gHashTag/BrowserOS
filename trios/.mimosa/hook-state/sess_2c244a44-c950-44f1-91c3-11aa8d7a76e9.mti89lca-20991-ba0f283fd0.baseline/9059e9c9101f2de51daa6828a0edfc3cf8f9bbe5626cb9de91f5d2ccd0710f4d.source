# Cycle 38 Plan - Pin-Aware Model Health Badge

## Weak spots

Cycle 37 made warmup, routing, and failover respect a per-conversation model pin, but the **Models tab UI still presents global controls as if no pin exists**:

1. The active model section shows `store.selectedModel` without indicating that the current conversation is pinned to it.
2. The "Warm up now" button calls `store.runAdaptiveWarmup()` unconstrained, which can switch the global default away from the pinned model and confuse the user when they return to the chat.
3. The cross-provider failover section lets the user enable the toggle and shows global probe results, giving no hint that pinned conversations will ignore cross-provider failover.
4. The custom-model "Use" button changes the global default, which does not affect a pinned conversation but is visually indistinguishable from changing the current conversation's model.

## Competitor patterns

- **ChatGPT / Claude desktop** show the active model at the top of the conversation and visually lock the picker while a generation is in progress; a pinned model is surfaced with a badge.
- **Cursor composer** displays a "pinned model" chip and disables or re-labels provider/model switch actions that would leave the pinned thread.
- **GitHub Copilot chat** uses a "Using ..." badge in the model settings panel and suppresses global model changes for threads that have a pinned capability profile.
- **OpenRouter web UI** shows `session_id` affinity; when a session is pinned to a model, the model row is highlighted and warmup/failover controls are scoped to that model.

## Decomposition

1. **Dependency injection** - pass the current `ChatViewModel` into `ModelsTabView` so it can read `conversationModelConstraint`.
2. **Computed view state** - add `isConversationModelPinned`, `pinnedModelLabel`, and `conversationModelConstraint` helpers to `ModelsTabView`.
3. **Active model badge** - in `activeModelSection`, render a `pin.fill` badge and label when the current conversation is pinned, showing provider, baseURL, and model.
4. **Constrained warmup button** - change the "Warm up now" button label to "Warm up pinned model" when pinned, call `runAdaptiveWarmup(constrainedTo: constraint)`, and add a help note explaining the constraint.
5. **Cross-provider note** - in `crossProviderSection`, show a small info label when pinned: "Cross-provider failover is ignored for pinned conversations."
6. **Custom model hint** - when pinned, show a one-line note under the custom-model row that changing the global default does not affect the pinned conversation.
7. **Tests & gates** - build, clade-build, clade-audit, clade-seal, trios-mesh tests. Add/update tests only if a clean unit surface is touched; the SwiftUI changes are covered by compilation.
8. **Report & options** - write the Cycle 38 report with three Cycle 39 options.

## Exit criteria

- `ModelsTabView` shows a visible pin badge for pinned conversations.
- Manual "Warm up now" respects the pin and never switches away from it.
- Cross-provider section explains the pin behavior.
- All Trinity gates pass with `TRIOS_SKIP_CHAT_E2E=1`.
