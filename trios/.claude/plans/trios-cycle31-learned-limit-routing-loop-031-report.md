# Cycle 31 Closure Report — Learned-Limit-Driven Request Sizing and Routing

**Date:** 2026-07-27  
**Ring:** SR-00 / SR-02 / BR-OUTPUT  
**Agent:** claude  
**Road:** B  
**Branch:** `feat/zai-provider`  
**Theme:** Close the loop between Cycle 30's learned context/output limits and pre-send request sizing/routing.

---

## 1. Weak spots addressed

Cycle 30 built `StreamingContextLimitLearner`, an async `ModelContextService.profile(...)` blend, and utilization badges, but the learned ceilings were still **read-only**. Three weak spots remained:

1. **Default output budget ignored learned ceilings.** `ChatRequestSizer` defaulted to 1,024 output tokens even when the learned effective `maxOutputTokens` for a provider endpoint was lower, so TriOS could request more than the observed ceiling.
2. **Post-routing input estimate was stale.** `ChatViewModel` computed `pendingEstimatedInputTokens` from the original `historyForRequest` before applying any routing/trimming decision. The streaming watchdog and utilization badge therefore saw the pre-trim estimate, not the actual request.
3. **Compiler warning in feedback path.** A Swift 6 concurrency warning flagged a mutable `request` captured by a `NetworkRetrier` closure in the thumbs-up/down feedback POST.

## 2. Competitor / topic scan

The dominant pattern across frontier chat clients (Claude Code, Cursor, OpenRouter) is to treat provider context/output specs as **ceilings** and let the user set a *per-request* budget below that ceiling. TriOS now does the inverse learning step as well: it tightens the ceiling from observed truncation, then caps the default budget and trims/routes against the tightened ceiling. The gap closed here is using those learned ceilings at the *pre-send sizing* layer, not only at the *mid-stream watchdog* layer.

## 3. Decomposed plan and implementation

### 3.1 Cap default output budget by learned `maxOutputTokens`
- **File:** `trios/rings/SR-00/ChatRequestSizer.swift`
- **Change:** `effectiveOutputTokens(requested:profile:)` now computes `requested ?? min(Self.defaultOutputBudget, profile.maxOutputTokens)` so the default output budget never exceeds the effective (learned-blended) output ceiling.
- **Test:** Added `ChatRequestSizerTests.testDefaultOutputBudgetCapsAtProfileMaxOutputTokens`.

### 3.2 Sync input estimate after routing/trimming
- **File:** `trios/rings/SR-02/ChatViewModel.swift`
- **Change:** After `resolveContextRoutingDecision` returns, `sendMessage` reconstructs `resolvedHistory` from `.trimHistory(...)` or keeps the original history, then re-estimates `resolvedInputEstimate` and assigns it to `pendingEstimatedInputTokens`. The watchdog and `contextUtilizationPercent` now reflect the real request that will be sent.

### 3.3 Fix Swift 6 captured-var warning in feedback POST
- **File:** `trios/rings/SR-02/ChatViewModel.swift`
- **Change:** Copied the mutable `request` to an immutable `feedbackRequest` before passing it into the `NetworkRetrier` closure, eliminating the captured-mutable-var warning.

### 3.4 Prove learned limits change routing decisions
- **File:** `trios/tests/TriOSKitTests/ModelConfigurationStoreCrossProviderTests.swift`
- **Change:** Added `testLearnedContextLimitTriggersTrimming`. It resets the shared learner, verifies a ~81k-token request fits the advertised 200k Claude window, records three `reason:"context limit"` outcomes at 80k total tokens, and then asserts the same request now resolves to `.trimHistory` because the learned effective context ceiling is lower than the advertised one.
- **Tear-down hygiene:** `tearDown` now resets the shared `StreamingContextLimitLearner` for the anthropic endpoint so learner state does not leak between tests.

## 4. Validation

| Gate | Command | Result |
|------|---------|--------|
| Swift build | `TRIOS_SKIP_CHAT_E2E=1 ./build.sh` | **PASS** (0 errors, only pre-existing warnings) |
| Rust mesh tests | `cargo test -p trios-mesh` | **PASS** (101 tests) |
| Rust clippy | `cargo clippy -p trios-mesh -- -D warnings` | **PASS** |
| Self-critic audit | `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit` | **0 findings** across all 8 checks |
| Promotion seal | `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal` | **SEAL VALID** |
| End-to-end smoke | `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e` | **FAIL** — BrowserOS Server at `127.0.0.1:9105/health` is down (connection refused). The TriOS app process is alive and the Swift logic tests pass. The server failure is an external dependency; the dev server requires a running CDP endpoint + Postgres, neither of which is available in this environment. |
| App relaunch | `open trios.app` | **OK** — new binary running (PID 88333), menu-bar logo present. |

> **Note on `swift test`:** The CommandLineTools-only toolchain does not include XCTest, so the new unit tests were compiled via `./build.sh` (they build as part of the kit) but not executed with `swift test`. They will run in CI where Xcode is present.

## 5. Uncommitted / new files

The following files are new in the working tree and have not been committed yet:

- `trios/rings/SR-00/ChatRequestSizer.swift` (untracked)
- `trios/tests/TriOSKitTests/ChatRequestSizerTests.swift` (untracked)

Tracked files modified:

- `trios/rings/SR-02/ChatViewModel.swift`
- `trios/tests/TriOSKitTests/ModelConfigurationStoreCrossProviderTests.swift`

## 6. Three Cycle 32 options

1. **Learned output-limit UI + per-send budget cap.** Extend `ModelsTabView` to show the learned effective `maxOutputTokens` and add a composer control that lets the user raise/lower the requested output budget per send, clamped by the learned ceiling. This makes the Cycle 31 sizing visible and controllable.
2. **Pre-send routing with larger-output candidates.** Generalize `resolveContextRoutingDecision` so that a user-requested output budget larger than the current model's learned ceiling can proactively route to a model whose learned/advertised output ceiling satisfies it (e.g., Claude Opus 8k → OpenAI 16k).
3. **Per-conversation context pinning + trim exclusions.** Let the user pin critical messages in a conversation so the trimmer never drops them, and persist the pin set per conversation. Combine with a "compact mode" button that trims aggressively on demand.
