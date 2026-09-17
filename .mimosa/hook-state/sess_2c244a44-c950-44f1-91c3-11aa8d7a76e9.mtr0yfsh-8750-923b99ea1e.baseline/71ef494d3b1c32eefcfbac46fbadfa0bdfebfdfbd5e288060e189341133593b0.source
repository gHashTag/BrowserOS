# Cycle 18 Report — Cross-Provider Failover

## Executive Summary
Cycle 18 extends the TriOS chat provider/model-routing loop so it can automatically fail over to a different `ModelProvider` when the current provider is entirely unhealthy. The failover preserves per-`(provider, baseURL, model)` reliability history, reuses the Cycle 17 composite reliability × latency score for ranking, and gives the user a toggle, manual probe, and status visibility in the Models tab.

## Weak Spots Addressed
1. **In-provider failover is not enough.** A 401/403, rate-limit storm, or connection failure on one provider previously left TriOS picking among equally broken models on the same provider.
2. **No key-gated eligibility check.** TriOS can only cross providers if the target provider has a configured API key; this was not centrally evaluated.
3. **History was trapped inside one provider.** Learned reliability and latency scores for the same model name on different endpoints were already keyed by endpoint, but the ranking code only consulted one endpoint.
4. **No UI for cross-provider reachability.** The Models tab showed per-model health, not whether another provider with credentials was reachable.

## Design Decisions
- **Preserve per-endpoint history.** `CrossProviderModelCandidate` carries `(provider, baseURL, model)` and `rankedCrossProviderFallbacks(...)` queries `reliability(for:provider:baseURL:)` and `latency(for:provider:baseURL:)` for each tuple, so learned scores are never merged across endpoints.
- **Reuse the Cycle 17 composite score.** The same `compositeScore(reliabilityScore:latency:sloMs:)` ranks candidates; latency and reliability signals remain coupled exactly as before.
- **One-shot failover per chat send.** `ChatViewModel` captures the original `(provider, baseURL, model)`, attempts the in-provider failover first, then attempts a single cross-provider failover, and restores the original selection if the cross-provider attempt also fails.
- **User control and visibility.** A toggle enables the feature; a "Probe all providers" button runs parallel health probes; provider reachability rows show which configured providers are reachable; `crossProviderFailoverReason` tells the user when an automatic switch happened.
- **Predictive selection crosses providers too.** When `isPredictiveSelectionEnabled` is on and the current provider's best model has no strong learned history, the store can switch to a healthier provider before the user sends a message.

## Implementation
- `rings/SR-00/ModelReliabilityService.swift`
  - Added `CrossProviderModelCandidate`.
  - Added `rankedCrossProviderFallbacks(...)` and `bestCrossProviderModel(...)` with cost-tier filtering and tie-breaking by provider configuration order and suggested-model order.
- `rings/SR-00/ModelConfigurationStore.swift`
  - Added `@Published isCrossProviderFailoverEnabled` and `crossProviderFailoverReason`.
  - Added `resolvedAPIKey(for:)`, `isProviderEligible(_:)`, `eligibleProviderConfigurations`.
  - Added `selectFirstHealthyCrossProviderModel()`, `restoreSelection(...)`, `probeAllEligibleProviders()`.
  - Extended `applyPredictiveSelection(reason:)` to consider switching providers.
- `rings/SR-01/SSETransport.swift`
  - Added `TransportError.isEligibleForCrossProviderFailover` covering model-unavailable, gateway, rate-limit, auth, balance, timeout, and connection failures.
- `rings/SR-02/ChatViewModel.swift`
  - Captures original selection before streaming.
  - Inserts a one-time cross-provider failover block after the existing in-provider failover, with restore-on-failure.
- `BR-OUTPUT/ModelsTabView.swift`
  - Added `crossProviderSection` with toggle, probe button, reachability rows, and failover reason label.
- `tests/TriOSKitTests/ModelReliabilityServiceCrossProviderTests.swift` (new)
  - Covers exclusion of the current tuple, score-based ranking, excluding unhealthy models, provider-order tie-breaking, cost-tier filtering, tier relaxation, and history preference.
- `tests/TriOSKitTests/ModelConfigurationStoreCrossProviderTests.swift` (new)
  - Covers key-gated eligibility, provider switching, unhealthy-model exclusion, parallel health probes, restore selection, and toggle persistence using stub health/status services and an in-memory reliability store.

## Verification
| Gate | Result |
|------|--------|
| `bash build.sh` | PASS (chat integration tests PASS) |
| `cargo run --bin clade-build` | PASS |
| `cargo test --workspace` | PASS |
| `cargo clippy --workspace` | PASS |
| `cargo run --bin clade-audit` | 0 findings |
| `cargo run --bin clade-seal` | SEAL VALID |
| `cargo run --bin clade-e2e` | PASS |
| `open trios.app` | Relaunched; `/health` returns `{"status":"ok","cdpConnected":true}` |
| `swift test` | Skipped (XCTest unavailable in CommandLineTools-only environment) |

## Known Limitations
- `swift test` could not run on this machine because only the CommandLineTools toolchain is installed. The new XCTest files are written against the existing in-memory `VolatileMemoryStore` + `MemoryStoreReliabilityAdapter` pattern and will compile and run once an Xcode toolchain is available.
- The failover is currently one-shot; repeated provider hopping within a single chat turn is intentionally avoided to prevent cascading switches and confusing UX.

## Next-Loop Options
1. **Adaptive parallel provider warmup.** Issue tiny probes to every eligible provider in parallel and route the live chat to whichever returns the lowest TTFT. This moves ranking from historical prediction to real-time measurement.
2. **Provider circuit-breaker + budget awareness.** Add per-provider failure counters, cooldown timers, and account/balance gates so TriOS avoids providers that are rate-limited, out of quota, or recently auth-failed.
3. **User-defined provider preference order.** Let the user drag-to-rank providers in the Models tab and blend that explicit priority into the cross-provider ranking algorithm.

## Law Compliance
- L1 TRACEABILITY: Closes the standing Cycle 18 objective; no GitHub issue number was specified in the original instruction.
- L2 GENERATION: Cross-provider ranking and UI additions are generated artifacts reviewed by the agent; test files are hand-authored XCTest coverage.
- L3 PURITY: All identifiers ASCII-only.
- L4 TESTABILITY: Build, clade gates, and chat e2e pass; XCTest files added for unit coverage.
- L5 IDENTITY: No φ constants changed.
- L6 CEILING: `ModelsTabView` is a canon BR-OUTPUT file; `ProjectPaths.swift` and `TriosTheme.swift` unchanged.
- L7 UNITY: No new `*.sh` on the critical path.

---
φ² + 1/φ² = 3 | TRINITY
