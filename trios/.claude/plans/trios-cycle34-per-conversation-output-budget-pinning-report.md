# Cycle 34 — Per-Conversation Output Budget Pinning

## Ring
SR-00 / SR-01 / SR-02 / BR-OUTPUT

## Road
B — fix + test + experience save

## Problem
Cycle 32/33 made the per-send output budget and context-window margin configurable globally, but a single global default does not fit every conversation thread. A coding chat benefits from a 4096+ token budget and a generous context margin, while a quick Q&A wants a 512-token cap and a tight margin. Users had to re-adjust the global default each time they switched contexts.

## Root cause
`ModelConfigurationStore` only persisted `requestedOutputTokens` and `contextWindowMargin` as global preferences. `ChatViewModel` always passed `modelStore.requestedOutputTokens` and `modelStore.contextWindowMargin` into routing and the streaming watchdog, so there was no data model or UI path for a conversation-scoped override.

## Fix
1. Added a `ConversationSettings` struct (`requestedOutputTokens: Int?`, `contextWindowMargin: Double?`) in `ChatProtocols.swift`; `nil` means "use the global default".
2. Extended `ChatPersisterProtocol` and `ConversationPersister` with `saveSettings(_:conversationId:)` and `loadSettings(conversationId:)`. Settings are encrypted with `ConversationEncryption` and stored as `Data` in the same `UserDefaults` suite as messages/titles.
3. Added effective accessors in `ChatViewModel`:
   - `effectiveConversationOutputTokens`
   - `effectiveConversationContextMargin`
   - `hasConversationOutputTokensOverride`
   and setters `setConversationRequestedOutputTokens`, `setConversationContextWindowMargin`, `clearConversationOutputTokensOverride`, `loadConversationSettings`.
4. Updated `performConversationSwitch` to load the conversation settings; updated `sendMessage` to pass the effective output budget and margin into `resolveContextRoutingDecision` and the streaming watchdog.
5. Extended `ModelConfigurationStore.resolveContextRoutingDecision(..., margin: Double? = nil)` so per-conversation margin flows through request sizing, candidate search, trimming, and the "too large even empty" check.
6. Wired `ChatPanelView.composerOutputBudgetControl` to edit the current conversation's override and show a "Default budget" item that clears the override. The help text now distinguishes conversation scope from global scope.

## Files
- `trios/rings/SR-01/ChatProtocols.swift`
- `trios/rings/SR-02/ConversationPersister.swift`
- `trios/rings/SR-02/ChatViewModel.swift`
- `trios/rings/SR-00/ModelConfigurationStore.swift`
- `trios/BR-OUTPUT/ChatPanelView.swift`
- `trios/tests/TriOSKitTests/ConversationEncryptionTests.swift`
- `trios/tests/TriOSKitTests/ModelConfigurationStoreCrossProviderTests.swift`
- `trios/.claude/plans/trios-cycle34-per-conversation-output-budget-pinning-report.md`
- `trios/.trinity/experience/2026-07-27_per-conversation-output-budget-pinning-loop-034.json`

## Tests
- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` PASS
- `cargo test -p trios-mesh` PASS (101 tests)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-build` PASS
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` PASS (0 hard-gate findings)
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` SEAL VALID
- `swift test` cannot run in this CommandLineTools-only toolchain (XCTest unavailable).

## Notes
- `trios.app` was rebuilt; the running app keeps the old binary until relaunched. Because the agent shell lacks Aqua/GUI access, run `open trios.app` from the user terminal to restore the menu-bar logo.
- `clade-e2e` was not run because `clade-audit`/`clade-seal` already cover the build/test gates and the BrowserOS server (`127.0.0.1:9105/health`) is unavailable in this environment.

## Cycle 35 options
1. **Per-conversation model/provider pinning** — remember a preferred `ModelProvider`, `baseURL`, and `model` per conversation thread so a coding chat always starts on a high-ceiling model even when the global default changes.
2. **Conversation-level learned-limit reset** — add an action to clear the learned context/output ceilings for the current conversation only, without resetting the global `StreamingContextLimitLearner` history.
3. **Budget-aware draft composer** — show the effective output budget and estimated input utilization inline in the composer as the user types, with a warning when the draft exceeds the conversation's pinned margin.
