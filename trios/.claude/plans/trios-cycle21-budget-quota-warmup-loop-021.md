# Cycle 21 Plan — Budget / Quota-Aware Adaptive Warmup Gating

**Date:** 2026-07-24  
**Branch:** `feat/zai-provider`  
**Selected variant:** A (from Cycle 20 options)  
**Road:** B — fix + test + experience save  

---

## 1. Weak spots in Cycle 20

1. **402 Insufficient Balance is swallowed.** `ModelHealthService.probeCloud` returns `.unknown(error: "Insufficient balance — not a model problem")` for HTTP 402. The warmup service then records it as `ProviderCircuitBreakerFailureKind.unknown`, so the provider is not treated as economically unavailable and may still be selected.
2. **Quota headers are ignored.** Successful probes from OpenRouter/OpenAI return `x-ratelimit-remaining-requests` / `x-ratelimit-remaining-tokens`. TriOS does not capture these, so a provider about to be throttled can win the warmup race.
3. **Warmup scoring is latency-only.** `ModelWarmupService.scoreCandidates` uses reliability × latency. A provider with depleted credits but fast latency still scores high because balance is not a scoring input.
4. **No per-endpoint quota tracking.** There is no actor or store that remembers the latest quota/balance snapshot for a `(provider, baseURL)` endpoint.
5. **UI lacks economic signals.** `ModelsTabView` shows circuit breaker state but not balance/quota status, so users cannot see *why* a provider was skipped.
6. **Breaker `.balance` cooldown is not distinct.** The breaker already has a `.balance` failure kind but applies the same cooldown logic as `.auth`; both should be longer/more visible than transient errors.

---

## 2. Competitor patterns

- **OpenRouter** returns `x-ratelimit-remaining-tokens` and `x-ratelimit-remaining-requests` on every streaming/non-streaming response. Many multi-provider clients (Helicone, Libellum) read these headers to route away from keys near exhaustion.
- **LiteLLM** supports per-key `budget` and `rpm/tpm` limits. Its router falls back when a key exceeds its configured spend or rate.
- **Portkey** "Guardrails" include spend controls and rate-limit awareness at the gateway layer.
- **Anyscale / Zeph-style** routers deprioritize providers whose quota is below a safety margin even when the endpoint is technically healthy.

TriOS will adopt a lightweight, header-based approach: parse standard rate-limit headers on probes, track balance/depletion signals, and feed them into warmup scoring.

---

## 3. Decomposed implementation tasks

### Task 1 — Data model: quota metadata
- Add `ProviderQuotaStatus` enum: `.unknown`, `.healthy(remainingRequests: Int?, remainingTokens: Int?)`, `.low(remainingRequests: Int?, remainingTokens: Int?)`, `.depleted(reason: String)`.
- Extend `ModelHealthResult` with an optional `quota: ProviderQuotaStatus?` field.
- Make all new types `Equatable`, `Sendable`.

### Task 2 — Capture quota headers in health probes
- Update `ModelHealthService.probeCloud` to capture the `HTTPURLResponse` headers.
- Map HTTP 402 to `.depleted(reason: "Insufficient balance")` in `ProviderQuotaStatus` and return `.unavailable(reason: "Insufficient balance")` as the health (so it is visible and trips the breaker correctly).
- Parse `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`, `x-ratelimit-limit-requests` (and OpenAI-style `x-ratelimit-remaining-requests`) from 2xx responses.
- Classify as `.low` when remaining requests ≤ 10% of limit or absolute ≤ 5, otherwise `.healthy`.

### Task 3 — Quota tracking service
- Add `ProviderQuotaService` actor keyed by `ProviderEndpointKey`.
- `record(proVIDER:baseURL:quota:)` updates the latest snapshot.
- `status(for:)` returns the latest `ProviderQuotaStatus`.
- Inject into `ModelConfigurationStore` and `ModelWarmupService`.

### Task 4 — Quota-aware warmup scoring
- Update `ModelWarmupService` initializer to accept `quotaService: ProviderQuotaService`.
- In `scoreCandidates`, after computing the reliability×latency score, read the quota status for each candidate's endpoint.
- Apply multipliers:
  - `.depleted` → score = 0 (filtered out unless it is the only candidate and strict gating is off).
  - `.low` → score × 0.5.
  - `.unknown` → score × 0.9.
  - `.healthy` → unchanged.
- Add a `strictQuotaGating: Bool` parameter; when true, `.depleted` candidates are excluded entirely.

### Task 5 — Circuit breaker balance handling
- In `ProviderCircuitBreaker.computeCooldown`, make `.balance` use the persistent multiplier but with a floor of `baseCooldown * 4` so balance issues are clearly slower to recover than transient errors.
- Ensure `ModelHealth.circuitBreakerFailureKind` maps "insufficient balance" / 402 to `.balance`.

### Task 6 — Store wiring and toggle
- Add `isStrictQuotaGatingEnabled: Bool` to `ModelConfigurationStore`, persisted in `UserDefaults`.
- Add `providerQuotaService: ProviderQuotaService` dependency to `ModelConfigurationStore`.
- Expose `quotaStatus(for provider:baseURL:)` helper.
- Pass strict-gating flag into `ModelWarmupService.warmup`.

### Task 7 — UI badges in ModelsTabView
- In the `adaptiveWarmupSection`, show a quota badge next to each provider row when `lastAdaptiveWarmupAt` is recent.
- Add a "Strict quota gating" toggle under the warmup section.
- In the breaker rows, show the quota status as a small label (e.g., "low quota", "depleted") when known.

### Task 8 — Tests
- Extend `ModelHealthServiceTests` to verify 402 mapping and header parsing.
- Add `ProviderQuotaServiceTests` for record/status round-trip.
- Extend `ModelWarmupServiceTests` to verify depleted provider is deprioritized and strict gating excludes it.
- Extend `ProviderCircuitBreakerTests` to verify balance cooldown is longer.

### Task 9 — Trinity gates
- Run `./build.sh`, `cargo test --workspace`, `cargo clippy --workspace`, `clade-audit`, `clade-seal`, `clade-e2e`, relaunch `trios.app`.

---

## 4. Files to touch

- `trios/rings/SR-00/ModelHealthService.swift` — capture headers, 402 mapping, quota metadata.
- `trios/rings/SR-00/ProviderQuotaService.swift` — new actor.
- `trios/rings/SR-00/ModelWarmupService.swift` — quota scoring, strict gating.
- `trios/rings/SR-00/ProviderCircuitBreaker.swift` — balance cooldown.
- `trios/rings/SR-00/ModelConfigurationStore.swift` — quota service, strict gating toggle, status helpers.
- `trios/BR-OUTPUT/ModelsTabView.swift` — quota badges, strict gating toggle.
- `trios/tests/TriOSKitTests/ModelHealthServiceTests.swift` — header/402 tests.
- `trios/tests/TriOSKitTests/ProviderQuotaServiceTests.swift` — new.
- `trios/tests/TriOSKitTests/ModelWarmupServiceTests.swift` — quota scoring tests.
- `trios/tests/TriOSKitTests/ProviderCircuitBreakerTests.swift` — balance cooldown test.

---

## 5. Success criteria

- `./build.sh` PASS
- `cargo test --workspace` PASS
- `cargo clippy --workspace` PASS
- `cargo run --bin clade-audit` hard gates 0 findings
- `cargo run --bin clade-seal` SEAL VALID
- `cargo run --bin clade-e2e` PASS
- `open trios.app` relaunched and `/health` ok
- Unit tests cover: 402 → depleted, rate-limit header parsing, depleted provider deprioritized, strict gating exclusion, balance cooldown longer.

---

## 6. Next-loop options (to be finalized in report)

1. **Predictive background warmup scheduling** — cache winners every 30-60s to remove warmup from the critical send path.
2. **User-defined provider preference order** — drag-to-rank providers in `ModelsTabView` and blend priority into scoring.
3. **Real-time spend dashboard** — track estimated spend per provider from response usage headers and show a running balance/cost estimate.
