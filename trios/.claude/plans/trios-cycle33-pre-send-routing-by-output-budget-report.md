# Cycle 33 — Pre-send Routing by Output Budget

## Theme
Extend TriOS's pre-send routing so that when a user requests an output-token budget larger than the current model's effective (learned/advertised) ceiling, the system proactively routes to a healthy candidate model that can honor the full budget, rather than silently clamping to the current model's ceiling.

## Decomposition
1. **Expose output-ceiling metadata** — `ChatRequestSize` already carried `effectiveOutputCeiling`; `ChatRequestSizer` already exposed `isOutputBudgetSaturated`. Add tests that prove both behave as expected.
2. **Add output-ceiling-first candidate search** — introduce `ModelContextService.largerOutputCandidates(...)` that returns candidates whose `maxOutputTokens >= requestedOutputTokens` and that still fit the estimated input within the safety margin, sorted by output ceiling descending then context window descending.
3. **Insert output-budget routing phase** — before the existing context-window routing in `ModelConfigurationStore.resolveContextRoutingDecision`, check if the current model fits the context window but cannot honor the raw requested output budget. If so, try `largerOutputCandidates`; if a healthy, allowed candidate fits, route to it.
4. **Surface routing cause in UI** — set explicit `lastContextRoutingReason` strings for output-budget vs. context-window routing. Update `ChatViewModel` to use the recorded reason as the routing label so users see why TriOS switched models.
5. **Add routing tests** — prove routing happens when a candidate satisfies the budget, and that TriOS stays on the current model when no candidate can satisfy the budget.
6. **Run Trinity gates** — build, mesh tests, clade-build, clade-audit, clade-seal, clade-e2e.

## Weak spots addressed
- **Silent clamping:** Users who requested a large output budget on a small-output model had their budget silently reduced. Now TriOS attempts to switch first.
- **Opaque routing:** The routing label did not distinguish output-budget switches from context-window switches. The reason string now tells the user exactly why.
- **Context-only ranking:** `largerModelCandidates` prioritized context window. A user asking for a long answer needs output ceiling prioritized; `largerOutputCandidates` does that.

## Competitor / prior-art observations
- OpenAI's model picker surfaces `max_tokens` per model but does not auto-route across providers.
- Cycle 27 introduced context-window pre-send routing; this cycle generalizes the same pattern to the output dimension, making the router 2-D (context + output) rather than 1-D.

## Files changed
- `trios/rings/SR-00/ModelContextService.swift` — added `largerOutputCandidates(...)`.
- `trios/rings/SR-00/ModelConfigurationStore.swift` — added output-budget routing phase and explicit routing reasons.
- `trios/rings/SR-02/ChatViewModel.swift` — uses `lastContextRoutingReason` for the routing label.
- `trios/tests/TriOSKitTests/ChatRequestSizerTests.swift` — added output-ceiling and saturation tests.
- `trios/tests/TriOSKitTests/ModelConfigurationStoreCrossProviderTests.swift` — added output-budget routing and no-candidate fallback tests.

## Test results
- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` — PASS
- `cargo test -p trios-mesh` — PASS (101 tests)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` — PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` — PASS, 0 hard-gate findings
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` — SEAL VALID
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e` — FAIL only on BrowserOS Server `127.0.0.1:9105/health` (external dependency unavailable)
- `swift test` — unavailable in CommandLineTools-only environment

## Operational note
The `trios.app` process was stopped during the rebuild. This agent shell session has no Aqua/GUI access, so `open trios.app` does not attach to the user's graphical session. The user should run `! open trios.app` in their terminal to restore the menu-bar logo; `clade-monitor`'s watchdog should also relaunch it within ~60s if running in the user's session.

## Next options for Cycle 34
1. **Per-conversation output budget pinning** — move `requestedOutputTokens` and `contextWindowMargin` from global `ModelConfigurationStore` defaults into per-thread `ConversationState`, with UI to override the global default per chat.
2. **Live output-budget progress bar** — render a streaming indicator in `ChatPanelView` showing consumed output tokens vs. the effective budget/ceiling, with color bands and approaching-limit warnings before the watchdog pauses.
3. **Output-budget-aware model badges** — in `ModelsTabView`, mark models whose effective `maxOutputTokens` can satisfy the current requested output budget with a "satisfies budget" badge so users know which models honor their chosen cap.
