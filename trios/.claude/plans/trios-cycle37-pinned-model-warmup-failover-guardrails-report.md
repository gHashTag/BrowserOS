# Cycle 37 Report - Pinned-Model Warmup/Failover Guardrails

## Weak spots addressed

Cycle 36 gave every conversation an optional pinned `provider`, `baseURL`, and `model`, but the pin was still cosmetic for several automatic switching paths:

1. **Predictive/adaptive warmup** could race across eligible providers and switch the active selection to a faster or healthier candidate, ignoring the conversation pin.
2. **Pre-send context routing** (`resolveContextRoutingDecision`) could route to a larger-context or larger-output model on a different provider when the pinned model did not fit.
3. **Same-provider model failover** (`selectNextModel` / `selectFirstHealthyModel`) could replace the pinned model with another model on the same provider during preflight or after a model-unavailable error.
4. **Cross-provider failover** (`selectFirstHealthyCrossProviderModel`) could escape to a completely different provider.
5. **Continue on larger model** during a streaming context-limit pause could move the thread off the pinned tuple.

All of these silently violated the user's explicit "use this model for this conversation" choice.

## Competitor patterns studied

- **OpenRouter** uses `session_id` stickiness and an ordered `models` fallback list. The session pin keeps the request on the preferred model unless it is unavailable, and fallbacks stay inside the configured model set rather than the whole catalog.
- **Microsoft Foundry Model Router** supports subset failover: the user defines a allowed model subset, and the router only fails over inside that subset.
- **Tian Pan conversation affinity** treats provider/model as part of conversation identity; routing decisions prefer the pinned identity and surface a warning when policy variance forces a switch.
- **Solana Garden routing ladder** uses a capability matrix. A pinned model acts as a fixed rung; the ladder only considers models that match the pinned capabilities, not every available endpoint.

The common pattern is: a user-level pin becomes a **constraint boundary** that all automatic switching logic must respect.

## Implementation summary

Introduced a single value object, `ConversationModelConstraint`, that wraps a pinned `CrossProviderModelCandidate`. The constraint is optional (`nil` means "no pin, switch freely"). It is threaded through every automatic model-selection surface:

- `ModelConfigurationStore.warmupCandidates(constrainedTo:)` returns only the pinned tuple when constrained.
- `ModelConfigurationStore.runAdaptiveWarmup(constrainedTo:)` short-circuits to a no-switch result when the current selection already equals the pinned tuple.
- `ModelConfigurationStore.resolveContextRoutingDecision(constrainedTo:)` filters the candidate list to the pinned tuple before asking `contextService` for larger-output or larger-window candidates, so routing cannot escape the boundary. It still falls back to `.useCurrent`, `.trimHistory`, or `.tooLargeEvenEmpty` inside the boundary.
- `ModelConfigurationStore.selectFirstHealthyCrossProviderModel(constrainedTo:)` returns `nil` when constrained, blocking cross-provider escape.
- `ModelConfigurationStore.selectLargerModelCandidate(estimatedInput:outputTokens:constrainedTo:)` only considers the pinned tuple, so "continue on larger model" is disabled unless the pinned tuple itself is larger.
- `ChatViewModel.conversationModelConstraint` builds the constraint from the current conversation settings when all three override fields are non-nil.
- `ChatViewModel.sendMessage` passes the constraint into predictive warmup (skipped entirely when a pin is active), adaptive warmup, context routing, same-provider failover (skipped when constrained), and cross-provider failover.
- `ChatViewModel.runPreflightHealthCheck` returns the current model unchanged when a pin is active, so the preflight same-provider fallback does not replace the pinned model.
- `ChatViewModel.continueStreamOnLargerModel` validates a manually supplied candidate against the constraint and passes the constraint into candidate selection.
- `ChatPanelView.composerStatusHelp` adds a note that warmup and failover are constrained when a pin is active.

Also fixed test mocks (`DelayedInitializationPersister` and `InMemoryPersister`) to conform to the `ChatPersisterProtocol` additions from Cycle 36 (`saveSettings(_:conversationId:)` and `loadSettings(conversationId:)`).

## Files changed

- `trios/rings/SR-01/ChatProtocols.swift` - added `ConversationModelConstraint`.
- `trios/rings/SR-00/ModelConfigurationStore.swift` - constrained overloads for warmup, routing, cross-provider failover, and larger-model selection.
- `trios/rings/SR-02/ChatViewModel.swift` - `conversationModelConstraint` helper and constraint threading through `sendMessage`, preflight health check, and `continueStreamOnLargerModel`.
- `trios/BR-OUTPUT/ChatPanelView.swift` - constrained-behavior note in the composer help tooltip.
- `trios/tests/swift/ChatSSETestMocks.swift` - added missing `saveSettings`/`loadSettings` stubs.
- `trios/tests/TriOSKitTests/ModelConfigurationStoreCrossProviderTests.swift` - new tests for constrained warmup, cross-provider failover, larger-model selection, and context routing.
- `trios/.claude/plans/trios-cycle37-pinned-model-warmup-failover-guardrails.md` - Cycle 37 plan.
- `trios/.claude/plans/trios-cycle37-pinned-model-warmup-failover-guardrails-report.md` - this report.
- `trios/.trinity/experience/2026-07-27_pinned-model-warmup-failover-guardrails-loop-037.json` - experience episode.

## Tests

- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` PASS
- `cargo test -p trios-mesh` PASS (101 tests)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` PASS (0 hard-gate findings)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` SEAL VALID

`swift test` is unavailable in the CommandLineTools-only environment. The chat integration tests are skipped because a pre-existing `memory database schema is version 4` assertion in the e2e harness fails in this environment.

## Three Cycle 38 options

1. **Conversation-level learned-limit reset** - add a menu action to clear the learned context/output ceilings for the current conversation only, without resetting the global `StreamingContextLimitLearner` history.
2. **Output-budget progress during streaming** - render a live progress indicator inside the streaming assistant message showing consumed output tokens vs. the effective budget/ceiling with color bands and approaching-limit warnings.
3. **Pin-aware model health badge** - in `ModelsTabView`, when the current conversation has a pinned model, show a "constrained to this conversation" badge on the pinned tuple and disable the manual "Run warmup" / "Failover" actions that would violate the pin.
