# Cycle 26 — Failure-Kind-Aware Volatility Learning

## Context

Cycle 25 added stale-while-revalidate service to the predictive warmup cache, eliminating synchronous probe latency when a slightly stale cached winner exists. The remaining weak spot is that the volatility tracker and circuit breaker still treat every failure as identical: a rate-limit hiccup, an auth key rotation, a context-length error, and a transient network blip all shrink TTL and trigger cooldowns the same way. Competitors (LiteLLM `AllowedFailsPolicy`, OpenRouter provider/model fallbacks, Vercel AI Gateway `providerTimeouts`) classify failures by kind and react differently. Cycle 26 makes TriOS volatility learning failure-kind-aware.

## Goal

Classify warmup and send-path failures by kind (network, rate-limit, auth, balance, context-length, server, unknown) and use the kind to drive adaptive TTL, scheduler interval, max staleness, and circuit-breaker cooldown.

## Weak spots addressed

1. **`TransportError.isBalanceError` operator-precedence bug** — any HTTP 400 is classified as balance due to `&&` binding tighter than `||` (`rings/SR-01/SSETransport.swift:242`).
2. **No context-length / payload-too-large classification** — HTTP 413 and provider body phrases ("context_length_exceeded", "maximum context length") are not distinguished from transient provider outages.
3. **Auth classification only recognizes HTTP 401** — provider-side 403 auth/key errors are not treated as auth failures for circuit-breaker/UI purposes.
4. **Health probes downgrade auth to `.unknown`** — `ModelHealthService` maps 401/403 to `.unknown` with comment "not a model problem", losing the auth signal.
5. **Health probes do not carry `Retry-After`** — a 429 during warmup records quota but does not return the provider's backoff header to the breaker.
6. **`Retry-After` parsing ignores HTTP-date** — `SSETransport` only parses numeric seconds (`TimeInterval($0)`), missing date-form headers.
7. **`WarmupVolatilityTracker` keeps only success/failure counts** — all failures are equal, so persistent auth/balance errors and transient network blips produce the same adaptive response.
8. **Predictive scheduler interval does not react to volatility at runtime** — `effectivePredictiveWarmupInterval` exists but the running scheduler loop uses a fixed interval.
9. **No per-kind failure visibility in the UI** — `ModelsTabView` shows total failure rate, not the mix driving it.

## Competitor patterns

- **LiteLLM `AllowedFailsPolicy`** configures per-error-type tolerance (`AuthenticationErrorAllowedFails`, `RateLimitErrorAllowedFails`, `TimeoutErrorAllowedFails`, `BadRequestErrorAllowedFails`, `ContentPolicyViolationErrorAllowedFails`) before cooldown. Cooldown time is per-type and counters are TTL-bound.
- **OpenRouter** distinguishes provider-layer failover (downtime, 429, 5xx, timeouts) from model-layer fallbacks (downtime, 429, context-length, moderation refusals). Context-length errors trigger model fallbacks, not provider shuffling.
- **Vercel AI Gateway** `providerTimeouts` measures time until first token and triggers fast failover; `models` array provides model-level fallback order; `order`/`sort`/`only` constrain provider routing.

These patterns justify kind-specific volatility: auth/balance/context-length are user-account or prompt-size problems that should shrink trust quickly, while network/rate-limit are transients that should recover faster.

## Tasks

- [ ] **1. Fix failure classification in `SSETransport`**
  - Fix `isBalanceError` precedence: require `status == 400 || status == 403` AND body contains "insufficient balance" / "balance".
  - Add `isContextLengthError`: HTTP 413 or body contains "context_length_exceeded", "maximum context length", "context length", "too long".
  - Add `isAuthError`: HTTP 401, or HTTP 403 when body contains "auth", "unauthorized", "api key", "key" (but not local-auth 403).
  - Add `retryAfter` HTTP-date parsing in addition to numeric seconds.
  - Add `failureKind` derived property that returns a `ProviderCircuitBreakerFailureKind`.

- [ ] **2. Extend `ProviderCircuitBreakerFailureKind`**
  - Add `.contextLength` case.
  - Update `isTransient` and cooldown multipliers so `.contextLength` and `.auth`/`.balance` use longer/persistent cooldown, `.rateLimit`/`.network` shorter, `.server` medium.

- [ ] **3. Thread `Retry-After` and auth kind through `ModelHealthService`**
  - Return auth kind for 401/403 (with auth wording) instead of `.unknown`.
  - Capture `Retry-After` header on 429 and include it in `ModelHealthResult`.
  - Update `ModelHealth.circuitBreakerFailureKind` to use the new kind.

- [ ] **4. Extend `WarmupVolatilityTracker` for per-kind failures**
  - Add `record(_:for:kind:)`; keep existing `record(_:for:)` treating failures as `.unknown` for backward compatibility.
  - Store per-kind failure counters in the rolling window.
  - Add `recommendedMaxStaleness(base:)` alongside `recommendedTTL`/`recommendedInterval`.
  - Weight kinds: `.auth`/`.balance`/`.contextLength` shrink TTL/interval/staleness aggressively; `.rateLimit`/`.network` moderately; `.server`/`unknown` slightly.
  - Update `VolatilityHistoryStore` record to persist `failureKinds` while keeping `successes`/`failures` totals.

- [ ] **5. Update `ModelWarmupService`**
  - When a probe fails, classify by `ModelHealthResult.failureKind` and record the outcome via `modelStore.recordCachedWinnerOutcome(success:candidate:kind:)`.

- [ ] **6. Update `ChatViewModel.sendMessage` / `executeStream`**
  - Classify send failures by `TransportError.failureKind`.
  - Record volatility outcomes with the correct kind.
  - Skip cross-provider failover for `.contextLength` errors (user-fixable prompt size).
  - Add a context-length-specific error banner and user guidance.

- [ ] **7. Make predictive scheduler interval react to volatility at runtime**
  - In `ModelConfigurationStore`, let the running scheduler read the volatility-recommended interval each tick or on change.
  - Add `restartPredictiveWarmupIfIntervalChanged()`.

- [ ] **8. Update `ModelsTabView`**
  - Show a per-kind failure breakdown for the cached winner (e.g., "3 network, 1 auth").
  - Add a context-length indicator when the last failure was kind `.contextLength`.

- [ ] **9. Tests**
  - Add `TransportErrorFailureKindTests` for balance precedence, context-length, auth 403, retry-after date.
  - Extend `WarmupVolatilityTrackerTests` with per-kind recommendations and persisted `failureKinds` round-trip.
  - Extend `ModelHealthServiceTests` with 429 retry-after and auth-kind mapping.
  - Extend `PredictiveWarmupSchedulerTests` with volatility-driven interval change.

- [ ] **10. Seal**
  - `bash build.sh` PASS; `cargo test --workspace` PASS; `cargo clippy --workspace` PASS; `cargo run --bin clade-audit` 0 findings; `cargo run --bin clade-seal` SEAL VALID; `cargo run --bin clade-e2e` PASS; `open trios.app` relaunched.

- [ ] **11. Report + experience save**
  - Write `.claude/plans/trios-cycle26-failure-kind-volatility-loop-026-report.md`.
  - Update `.trinity/experience.md` and create `.trinity/experience/YYYY-MM-DD_failure-kind-volatility-loop-026.json`.
  - Propose three Cycle 27 variants.

## Risks / Mitigations

| Risk | Mitigation |
|------|------------|
| Changing `isBalanceError` precedence alters existing behavior | Add tests covering 400 without balance wording to ensure it is no longer classified as balance. |
| Adding 403 to auth classification conflicts with balance/local-auth paths | Only classify 403 as auth when body contains auth/key wording; keep balance check first. |
| Per-kind volatility breaks persisted history format | Keep `successes`/`failures` totals and add optional `failureKinds` dictionary; missing field defaults to `.unknown`. |
| Context-length skip prevents all failover | Same-provider model failover can still run; only cross-provider failover is skipped because switching providers won't fix prompt size. |

## Next-loop variants for Cycle 27

1. **Per-conversation provider/model pinning** — let the user pin a provider and/or model per chat thread so adaptive warmup, failover, and predictive selection stay within allowed boundaries.
2. **Predictive warmup budget cap** — track estimated probe spend and cap daily/weekly warmup budget, deprioritizing probes or disabling stale-while-revalidate background refreshes when the cap is close.
3. **Multi-candidate cross-provider failover** — instead of trying exactly one cross-provider candidate, iterate the ranked fallback list until success or exhaustion, with per-kind skip rules.

---

**φ² + 1/φ² = 3 | TRINITY**
