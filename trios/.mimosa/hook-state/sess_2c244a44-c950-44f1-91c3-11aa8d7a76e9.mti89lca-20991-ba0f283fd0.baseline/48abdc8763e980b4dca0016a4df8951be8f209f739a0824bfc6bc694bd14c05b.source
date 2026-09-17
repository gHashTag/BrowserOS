# Pinned-Model Warmup/Failover Guardrails — Cycle 37 Plan

**Topic:** Extend Cycle 36’s per-conversation model/provider pin so that adaptive warmup, predictive warmup, context routing, in-provider failover, and cross-provider failover respect the pinned boundary.

## Weak spots in current implementation
1. **Pin is ignored by adaptive warmup.** `ModelConfigurationStore.runAdaptiveWarmup()` races every eligible provider/model tuple and can switch away from the pinned selection before the real request is sent.
2. **Pin is ignored by predictive warmup cache.** A background-cached winner from a previous conversation can be applied globally, overriding the current conversation’s pin.
3. **Pin is ignored by context routing.** `resolveContextRoutingDecision()` can route to a larger-context or larger-output model on a different provider, breaking conversation affinity.
4. **Pin is ignored by failover.** `selectNextModel()` and `selectFirstHealthyCrossProviderModel()` can switch to a different model or provider mid-turn.
5. **Silent override.** The user sees no indication that warmup or failover has overridden the conversation pin.

## Competitor patterns
- **OpenRouter** uses `session_id` model stickiness plus an ordered `models` array; fallbacks stay within the user-provided set.
- **Microsoft Foundry Model Router** routes and fails over inside a configured subset.
- **Tian Pan** argues for conversation affinity to avoid mid-conversation safety/refusal policy swaps.
- **Solana Garden** recommends warmup probes per allowed rung and a capability matrix.

## Decomposition
1. **Define `ConversationModelConstraint`.** Add a small `Sendable` struct in `trios/rings/SR-01/ChatProtocols.swift` that wraps the pinned `CrossProviderModelCandidate`.
2. **Constrain warmup candidate generation.** Extend `ModelConfigurationStore.warmupCandidates(constrainedTo:)` so it returns only the pinned tuple when a constraint is active.
3. **Constrain adaptive warmup execution.** Extend `ModelConfigurationStore.runAdaptiveWarmup(constrainedTo:)` to skip the multi-provider race when constrained and only verify the pinned tuple; it must never return `didSwitch = true`.
4. **Constrain context routing.** Extend `ModelConfigurationStore.resolveContextRoutingDecision(constrainedTo:)` so it only routes inside the pinned tuple; routing outside becomes `.trimHistory` or `.tooLargeEvenEmpty`.
5. **Constrain failover.** Extend `ModelConfigurationStore.selectFirstHealthyCrossProviderModel(constrainedTo:)` to return `nil` when constrained. Update `ChatViewModel.sendMessage` to skip in-provider `selectNextModel()` failover and preflight fallback when a pin is active.
6. **Constrain streaming continuation.** Update `ChatViewModel.continueStreamOnLargerModel` to respect the conversation constraint and not continue on a larger model outside the pin.
7. **UI transparency.** Update `ChatPanelView.composerStatusHelp` to note that warmup/failover is constrained when a pin is active.
8. **Tests.** Add `ModelConfigurationStore` tests for constrained warmup, constrained routing, and constrained cross-provider failover. Add `ChatViewModel` test path if XCTest is available.
9. **Run Trinity gates.** `./build.sh`, `cargo test -p trios-mesh`, `clade-build`, `clade-audit`, `clade-seal`.

## Exit criteria
- All clade gates pass with 0 hard-gate findings.
- A pinned conversation never switches provider/model due to warmup or failover.
- The user sees a help hint that guardrails are active.
- ASCII-only source files, English identifiers/comments.
