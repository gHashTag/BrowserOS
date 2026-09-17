# Cycle 19 Plan — Provider Circuit Breaker & Failover Hardening

## Context
Cycle 18 shipped cross-provider failover: TriOS can now switch from an unhealthy provider to another eligible provider with configured credentials. The ranking reuses Cycle 17 composite reliability × latency scores and preserves per-`(provider, baseURL, model)` history.

## Weak Spots Identified
1. **Failover target is not live-health verified** — `selectFirstHealthyCrossProviderModel()` ranks by historical EMA and may switch to a provider that is currently rate-limited or down.
2. **`unhealthyModels` keyed by model name only** — a model marked unhealthy on Provider A is wrongly skipped on Provider B, and vice versa.
3. **Cross-provider failover toggle does not fully gate failover** — a specific branch in `ChatViewModel` can cross providers even when the user disabled the toggle.
4. **No provider-level circuit breaker / cooldown / budget tracking** — 401/402/429/503 errors are detected but not persisted as per-provider state, so the same broken provider is retried on every new chat turn.
5. **No UX visibility for provider error/cooldown state** — users cannot see why a provider is unavailable or when it will be retried.

## Competitor Patterns Adopted
- **LiteLLM cooldowns**: per-deployment cooldown on 429/non-retryable errors with configurable `allowed_fails` and `cooldown_time`.
- **Envoy circuit breaker**: tri-state (closed/open/half-open) with failure threshold, cooldown, and single probe to test recovery.
- **resilient-llm / rate-limit-shield**: token-bucket + circuit breaker + `Retry-After` awareness + jittered exponential backoff.
- **OpenRouter provider controls**: explicit provider ordering and failure tracking; unstable providers are deprioritized but kept as fallbacks.

## Three Variants

### Variant A — Provider Circuit Breaker + Retry-After honoring (recommended)
Add a `ProviderCircuitBreaker` actor keyed by `(provider, baseURL)` with tri-state logic. On eligible transport failures (auth, balance, rate-limit, gateway, connection), trip the breaker to `open` for a cooldown. Honor `Retry-After` headers; otherwise use exponential backoff. Exclude `open` providers from ranking and preflight; use `half-open` for a single probe before allowing traffic. Update Models tab to show last error kind, failure streak, and next-retry timestamp. Fix `unhealthyModels` keying and toggle gating.

**Pros:** Directly hardens Cycle 18 failover; prevents retry storms; small, well-scoped surface.  
**Cons:** Adds new state actor and UI; requires careful integration with predictive selection.  
**Complexity:** Medium.

### Variant B — Token-bucket RPM/TPM admission + cost-tier failover
Add per-(provider, baseURL) client-side RPM/TPM token buckets and enforce them before each request. Pass `preferredCostTier` into cross-provider ranking. When the current provider is rate-limited by the bucket, proactively route to the next eligible provider respecting cost tier.

**Pros:** Prevents 429 storms; respects user cost preference during failover.  
**Cons:** Token rates must be configured per provider; RPM/TPM are rough proxies without response token counts.  
**Complexity:** Medium.

### Variant C — User-defined provider preference order + re-home on recovery
Add a drag-to-rank provider list in Models tab and store the order. Use it as a tie-breaker in cross-provider ranking. Remember the preferred `(provider, baseURL, model)` before failover; when background health polling shows recovery, offer/switch back to the preferred provider.

**Pros:** Gives users explicit control; reduces surprise from automatic scoring.  
**Cons:** UI-heavy (drag-to-rank in SwiftUI); re-home logic can create oscillation if not dampened.  
**Complexity:** Medium-High.

## Recommended Variant
**Variant A.** It closes the most critical gap left by Cycle 18 (switching to a still-broken provider) and fixes two existing bugs (toggle gating and per-provider unhealthy keying) in the same coherent change. RPM/TPM and user preference can follow in later cycles.

## Task Breakdown
1. Create `rings/SR-00/ProviderCircuitBreaker.swift` with `CircuitBreakerState`, `ProviderCircuitBreakerKey`, failure-kind enum, tri-state transitions, `recordFailure(...)`, `recordSuccess(...)`, `canSend(...)`, `shouldProbe(...)`, `nextRetryAt`, `state(for:)`.
2. Update `rings/SR-00/ModelConfigurationStore.swift`:
   - Replace `unhealthyModels: Set<String>` with a per-tuple structure (e.g., `unhealthyTuples: Set<ModelTupleKey>` or per-provider model set).
   - Inject `ProviderCircuitBreaker`.
   - Use breaker state in `selectFirstHealthyCrossProviderModel()`, `applyPredictiveSelection()`, preflight health checks, and `probeAllEligibleProviders()`.
   - Fix cross-provider failover toggle gating in callers (do not cross providers when disabled).
   - Expose breaker state for UI: last error kind, failure streak, next retry.
3. Update `rings/SR-02/ChatViewModel.swift`:
   - Record transport failures into the breaker via `recordFailure(provider:baseURL:kind:retryAfter:)`.
   - Ensure the cross-provider branch respects `isCrossProviderFailoverEnabled`.
   - Mark the failed tuple as unhealthy, not just the model name.
4. Update `rings/SR-01/SSETransport.swift`:
   - Expose `failureKind` and `retryAfter` from `TransportError` cases.
   - Parse `Retry-After` header where present.
5. Update `BR-OUTPUT/ModelsTabView.swift`:
   - Add per-provider error/cooldown rows in the cross-provider section.
   - Show last error kind, streak, and next retry time.
6. Add tests:
   - `tests/TriOSKitTests/ProviderCircuitBreakerTests.swift` — state transitions, cooldown, half-open, Retry-After.
   - Update `ModelConfigurationStoreCrossProviderTests.swift` — breaker-gated ranking and toggle gating.
   - Update `ChatViewModel` tests if feasible.
7. Run Trinity gates and fix regressions.
8. Save experience and write final report.

## Test Plan
- Unit tests for `ProviderCircuitBreaker`: closed→open on threshold, open→half-open after cooldown, half-open→closed on success, open→open on failure, `Retry-After` overrides default backoff.
- Unit tests for `ModelConfigurationStore`: breaker excludes open providers from ranking; per-tuple unhealthy excludes only the failing tuple; toggle disables cross-provider failover.
- Chat integration tests (`tests/swift/run_chat_sse_e2e.sh`) continue to pass.
- Build + clade-audit + clade-seal + clade-e2e must pass.

## Gate Checklist
- [x] `bash build.sh` passes (chat integration tests pass)
- [x] `cargo run --bin clade-build` passes
- [x] `cargo test --workspace` passes
- [x] `cargo clippy --workspace` passes
- [x] `cargo run --bin clade-audit` 0 findings
- [x] `cargo run --bin clade-seal` SEAL VALID
- [x] `cargo run --bin clade-e2e` passes
- [x] `open trios.app` relaunched and `/health` returns ok
- [x] No new `*.sh` on critical path (L7 UNITY)

## Risks
- **Scope creep**: combining breaker, unhealthy keying, and toggle fix in one cycle is coherent but must stay focused; avoid adding RPM/TPM or re-home logic here.
- **State explosion**: breaker state is in-memory only like `unhealthyModels`; acceptable for this cycle, but persistence can be added later.
- **Half-open probe UX**: a single probe that fails may briefly surface an error to the user; use health-probe path, not a live user request, for half-open tests.
- **Swift 6 actor isolation**: `ProviderCircuitBreaker` must be `Sendable` and integrate cleanly with `ModelConfigurationStore` `@MainActor` boundary.

## Next-Loop Options (post-Cycle-19)
1. **Adaptive parallel provider warmup** — race tiny probes across eligible providers and route to the lowest TTFT winner.
2. **Token-bucket RPM/TPM client-side rate limiting** — prevent 429 storms and respect provider concurrency limits.
3. **User-defined provider preference order + re-home on recovery** — drag-to-rank providers and switch back to the preferred provider when healthy.

---
φ² + 1/φ² = 3 | TRINITY
