# Cycle 19 Final Report — Provider Circuit Breaker & Failover Hardening

**Date:** 2026-07-24  
**Branch:** `feat/zai-provider` (base: `dev`)  
**Ring:** SR-00 / SR-01 / SR-02 / BR-OUTPUT  
**Road:** B — fix + test + experience save  
**Implemented variant:** A (provider circuit breaker + `Retry-After` honoring + per-tuple unhealthy keying + toggle gating fix)

---

## 1. What was weak

Cycle 18 shipped cross-provider failover, but several hard spots remained:

1. **No provider-level failure isolation.** A provider returning 401/402/429/503 could be retried repeatedly within the same chat turn and on every new turn. There was no cooldown or open-circuit state.
2. **`unhealthyModels` keyed by model name only.** A model marked bad on Provider A was wrongly skipped on Provider B, and vice versa.
3. **Cross-provider failover toggle did not fully gate failover.** `ChatViewModel` contained `if !didFailover || store.isCrossProviderFailoverEnabled`, which is logically always true, allowing cross-provider switching when the user disabled it.
4. **No `Retry-After` propagation.** Rate-limit responses could tell us exactly when to retry, but `TransportError` threw that information away.
5. **No UX for provider cooldown state.** The Models tab showed per-provider health probes but not whether a provider was currently circuit-open or when it would be retried.

## 2. Competitor patterns researched

- **LiteLLM cooldowns** — per-deployment `allowed_fails` + `cooldown_time`, with failure-kind-specific timeouts.
- **Envoy circuit breaker** — tri-state closed/open/half-open, failure threshold, cooldown, single probe to test recovery.
- **resilient-llm / rate-limit-shield** — circuit breaker + `Retry-After` awareness + exponential backoff.
- **OpenRouter provider controls** — explicit provider ordering and failure tracking; unstable providers are deprioritized but retained as fallbacks.

## 3. Decomposed plan

The plan (`.claude/plans/trios-cycle19-provider-circuit-breaker-loop-019.md`) selected **Variant A** as the recommended scope:

- Add a `ProviderCircuitBreaker` actor keyed by `(provider, baseURL)`.
- Extend `TransportError.serverError` with an optional `retryAfter` value and expose a failure-kind mapping.
- Replace single-key `unhealthyModels` logic with per-tuple `unhealthyTuples` while keeping the string set for UI compatibility.
- Gate `selectFirstHealthyCrossProviderModel`, predictive selection, and preflight checks through the breaker.
- Fix the toggle gating bug in `ChatViewModel` and record breaker success/failure around all send paths.
- Add per-provider circuit-breaker status rows to `ModelsTabView`.
- Add `ProviderCircuitBreakerTests.swift` and run all Trinity gates.

## 4. What was implemented

### New files
- `trios/rings/SR-00/ProviderCircuitBreaker.swift`
  - `ModelEndpointTuple` (provider, baseURL, model)
  - `ProviderEndpointKey` (provider, baseURL)
  - `ProviderCircuitBreakerFailureKind` (`rateLimit`, `auth`, `balance`, `gateway`, `connection`, `timeout`, `modelUnavailable`, `unknown`) with kind-aware transient/persistent cooldown policy
  - `ProviderCircuitBreakerState` (`closed`, `open`, `halfOpen`)
  - `ProviderCircuitBreaker` actor with configurable threshold, base/max cooldown, half-open probe timeout, multipliers, and injectable clock for testing
  - `TransportError.circuitBreakerFailureKind` extension
- `trios/tests/TriOSKitTests/ProviderCircuitBreakerTests.swift`
  - 11 tests covering initial state, threshold, cooldown, `Retry-After`, half-open success/failure, kind-aware cooldown length, reset, transport-error mapping, and endpoint isolation.

### Modified files
- `trios/rings/SR-00/ModelConfigurationStore.swift`
  - Added `unhealthyTuples` and kept `unhealthyModels` as a conservative UI set.
  - Added `circuitBreaker: ProviderCircuitBreaker` and helper methods: `recordCircuitBreakerFailure`, `recordCircuitBreakerSuccess`, `circuitBreakerState`, `circuitBreakerNextRetryAt`, `circuitBreakerLastFailureKind`, `circuitBreakerCanSend`, `resetCircuitBreakerForCurrentProvider`, and an overload for arbitrary endpoints.
  - Rewrote `selectFirstHealthyCrossProviderModel()` to filter eligible providers by breaker state (synchronously looped because Swift does not allow `async` closures in `filter`), rank by reliability/latency, re-check breaker state and per-tuple unhealthy flags, then live-probe candidates until one is healthy.
  - Updated `applyPredictiveSelection()` to skip the current provider when its breaker is open and to filter cross-provider configs through `canSend`.
  - Fixed async-filter usage in cross-provider ranking by replacing `.filter { await ... }` with explicit loops.
- `trios/rings/SR-01/SSETransport.swift`
  - Added `retryAfter: TimeInterval? = nil` to `TransportError.serverError`.
  - Parsed the `Retry-After` HTTP header in `performMessageStream` and stored it in the error.
  - Added `retryAfter` computed property.
  - Updated all `switch`/`if case` patterns to match the four associated values.
- `trios/rings/SR-02/ChatViewModel.swift`
  - Marked the original failed tuple as unhealthy with `modelStore.markUnhealthy(provider:baseURL:model:)`.
  - Recorded breaker failures for transport errors eligible for cross-provider failover.
  - Added `recordCircuitBreakerSuccess()` after successful main send, in-provider failover success, and cross-provider failover success.
  - Recorded breaker failure for a failed cross-provider candidate on its own endpoint.
  - Fixed the toggle gating bug: `if !didFailover || modelStore.isCrossProviderFailoverEnabled` → `if modelStore.isCrossProviderFailoverEnabled`.
- `trios/BR-OUTPUT/ModelsTabView.swift`
  - Added a per-provider circuit-breaker status list inside the cross-provider section.
  - Shows provider name, base URL, breaker state icon/color, last failure kind, and next retry time.
  - Added `refreshCircuitBreakerStates()` and helper label/color/icon functions.

## 5. Validation

| Gate | Result |
|---|---|
| `bash build.sh` | **PASS** — chat integration tests pass |
| `cargo run --bin clade-build` | **PASS** |
| `cargo test --workspace` | **PASS** |
| `cargo clippy --workspace` | **PASS** |
| `cargo run --bin clade-audit` | **0 findings** |
| `cargo run --bin clade-seal` | **SEAL VALID** |
| `cargo run --bin clade-e2e` | **PASS** |
| `open trios.app` + `/health` | `{"status":"ok","cdpConnected":true}` |

`swift test` remains unavailable in this CommandLineTools-only environment; the new `ProviderCircuitBreakerTests.swift` was written for CI/Xcode.

## 6. Three next-loop options

1. **Adaptive parallel provider warmup** — issue tiny, cheap probes to all eligible providers before a chat send and route the live request to the lowest-TTFT winner. This closes the remaining gap where historical scores can lag behind live provider health.
2. **Account/budget-aware failover** — read provider balance, quota, or out-of-credit headers and gate failover away from out-of-quota providers until the user tops up. Builds directly on the breaker failure kinds already added.
3. **User-defined provider preference order** — add a drag-to-rank provider list in the Models tab and blend that priority into cross-provider ranking as a tie-breaker above the learned score.

---

φ² + 1/φ² = 3 | TRINITY
