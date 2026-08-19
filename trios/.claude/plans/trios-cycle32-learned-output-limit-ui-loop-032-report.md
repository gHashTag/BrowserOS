# Cycle 32 Report — Learned Output-Limit UI + Per-Send Budget Cap

## Summary
Cycle 32 exposed the effective (advertised + learned) per-model output ceiling in the UI and gave the user a per-send output-token budget that is clamped to that ceiling before it reaches the provider.

## Weak spots addressed
- **Invisible ceiling:** `ModelsTabView` showed raw learned observations (`learned out: X`) but not the *effective* `maxOutputTokens` that `ChatRequestSizer` and the watchdog actually use.
- **No user control:** The only way to influence output length was indirect (system prompt hints). There was no first-class token budget.
- **Request body gap:** Even if a budget existed internally, `ChatRequestBuilder` never emitted `max_tokens`, so the provider could not honor it.
- **Continuation mismatch:** `continueStreamOnLargerModel` hardcoded `outputTokens: 1024`, ignoring a user who had already set a higher per-send budget.

## Competitor / prior-art notes
- Most chat clients hide `max_tokens` in settings; TriOS puts it one tap away in the composer toolbar without requiring a settings dive.
- Learned ceilings are TriOS-specific (Cycle 30-31); surfacing them as the clamp source makes the budget control trustworthy even when providers silently change limits or different base URLs serve the same model slug with different ceilings.

## Changes

### `rings/SR-00/ModelProvider.swift`
- Added `maxOutputTokens: Int?` to `ModelRuntimeConfiguration`.
- `apply(to:)` now writes `body["max_tokens"]` when the value is present and positive.
- `environmentFallback` passes `nil` explicitly for the new field.

### `rings/SR-00/ModelConfigurationStore.swift`
- Added `@Published var requestedOutputTokens: Int?` with UserDefaults persistence under `trios.model.requested-output-tokens`.
- Added `setRequestedOutputTokens(_:)`, `clearRequestedOutputTokens()`, `loadRequestedOutputTokens()`.
- Added `effectiveMaxOutputTokens(for:provider:baseURL:)` to read the blended profile ceiling.
- Added `effectiveRequestedOutputTokens(for:provider:baseURL:)` to clamp the user's request to that ceiling.
- Updated `runtimeConfiguration` to forward the clamped budget; `runtimeConfigurationSync` passes the raw user value (sync callers must clamp separately).

### `rings/SR-02/ChatViewModel.swift`
- `sendMessage` now passes `modelStore.requestedOutputTokens` to `resolveContextRoutingDecision` so the sizer/trimmer see the same budget that will be sent to the provider.
- `continueStreamOnLargerModel` uses `modelStore.effectiveRequestedOutputTokens(...)` instead of hardcoded `1024` when selecting a larger-output candidate.

### `BR-OUTPUT/ChatPanelView.swift`
- Added `composerOutputBudgetControl` to `composerToolbar` (between context status and token status).
- Compact `Menu` with a "Default budget" option and presets `256, 512, 1k, 2k, 4k, 8k, 16k, 32k, 64k`.
- Presets above the effective ceiling are disabled.
- Label shows current request / ceiling (e.g. `4.0k/8.0k` or `out ≤ 8.0k` when default).
- Added `.task(id:)` that refreshes `effectiveOutputCeiling` whenever provider/model/baseURL change.

### `BR-OUTPUT/ModelsTabView.swift`
- Added effective output-limit line under the active model identifier: `Effective output limit: X • learned out: Y`.
- `refreshContextUtilizationBadges()` now also computes `effectiveOutputCeiling`.
- Triggers refresh on appear and on provider change, so the ceiling updates without waiting for `modelsTabRequest`.

### Tests
- `ChatRequestBuilderTests.testMaxTokensEmittedWhenSet` / `testMaxTokensOmittedWhenNil`
- `ChatRequestSizerTests.testRequestedOutputTokensClampedByProfileCeiling` / `testRequestedOutputTokensBelowCeilingIsHonored`

## Validation
- `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` — **PASS**
- `cargo test -p trios-mesh` — **PASS** (101 tests)
- `cargo run --bin clade-build` — **PASS**
- `cargo check --workspace` — **PASS**
- `cargo run --bin clade-e2e` — **1 FAIL**: BrowserOS Server `127.0.0.1:9105/health` is down (external dependency: dev server requires a running CDP endpoint and Postgres, neither available in this environment). Swift logic tests and app PID checks passed.
- `cargo run --bin clade-audit` / `cargo run --bin clade-seal` — **hang at check 1** because they invoke `./build.sh` without `TRIOS_SKIP_CHAT_E2E=1` and block on the unavailable server. Re-running `./build.sh` directly with the skip flag passes.
- `open trios.app` relaunched; menu-bar logo present.

## Cycle 33 options
1. **Pre-send routing by output budget** — extend `resolveContextRoutingDecision` to consider both context-window and output-ceiling fit, and route to a candidate whose effective `maxOutputTokens` satisfies the user-requested budget (e.g. ask for a 32k-token answer and TriOS picks a model that can actually deliver it).
2. **Per-conversation output budget pinning** — let each conversation thread remember its own `requestedOutputTokens` and context-window margin in `ConversationPersister`, overriding the global default only for that thread; useful for long-form writing chats vs. quick Q&A chats.
3. **Live output-budget progress bar** — add a streaming indicator showing consumed output tokens vs. the effective budget/ceiling with color bands, and surface approaching-limit warnings before the watchdog pauses so the user can proactively choose to continue/summarize/stop.
