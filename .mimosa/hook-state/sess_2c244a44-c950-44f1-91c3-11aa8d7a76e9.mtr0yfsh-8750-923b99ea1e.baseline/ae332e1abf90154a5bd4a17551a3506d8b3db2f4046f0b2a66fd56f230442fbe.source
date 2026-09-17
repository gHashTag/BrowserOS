# Cycle 20 Final Report — Adaptive Parallel Provider Warmup

**Date:** 2026-07-24  
**Branch:** `feat/zai-provider`  
**Target:** `dev` (landed in-place)  
**Road:** B — fix + test + experience save  
**Agent:** claude

---

## 1. Objective

Extend the Cycle 19 provider circuit-breaker and cross-provider failover stack so that TriOS can **proactively** choose the fastest reachable provider/model/baseURL before committing the user's chat message, instead of starting on the pre-selected tuple and failing over reactively.

---

## 2. Research Summary

### Weak spots identified in Cycle 19
1. **Reactive-only routing.** `ChatViewModel` selected a provider/model and only rerouted after `TransportError`. A slow-but-not-failing provider could add seconds of latency before the first token.
2. **Stale ranking signal.** `ModelReliabilityService` ranked by EMA reliability × latency, but the latency component was historical; a provider that became slow or overloaded 30 seconds ago would still look good until the next background poller cycle.
3. **Half-open thundering herd.** `ProviderCircuitBreaker` recovery used a fixed cooldown. Multiple concurrent half-open endpoints could recover simultaneously and all hit the same recovering provider.
4. **Hung probe could wedge recovery.** Half-open state relied on `recordFailure`/`recordSuccess` to close/reopen the breaker, but a probe that never completed left the breaker open forever.

### Competitor / pattern research
- **Zephyr / Anyscale / Skyplane LLM routers** issue tiny pre-flight probes (often `max_tokens:1` or empty completions) and route the live request to the probe with lowest TTFT. This is the dominant pattern for multi-provider LLM clients.
- **Envoy / Resilience4j circuit breakers** use single-probe permits in half-open to prevent concurrent recovery attempts and a `permittedNumberOfCallsInHalfOpenState` of 1.
- **AWS SDK / Polly jitter** applies deterministic or random jitter to backoff to desynchronize retries. We chose deterministic jitter from the endpoint-key hash so the same endpoint always jitters the same way (easier to reason about and test) while different endpoints desynchronize.

---

## 3. Decomposed Plan and Implementation

### 3.1 ProviderCircuitBreaker hardening
- Added `isProbing: Bool` and `probeStartedAt: Date?` to `Entry`.
- Added `probingKeys: Set<ProviderEndpointKey>` to track which endpoints currently hold the single half-open probe permit.
- `beginProbe` acquires the permit; `endProbe` records success/failure and releases it.
- `releaseStuckProbeIfNeeded` auto-releases permits older than `halfOpenProbeTimeout` so a hung probe cannot block recovery.
- `computeCooldown(key:)` now takes the endpoint key and adds deterministic jitter:
  ```swift
  let hash = abs(key.hashValue)
  let ratio = Double(hash % 1_000_000) / 1_000_000.0
  let jitter = cooldown * jitterFactor * (ratio * 2 - 1)
  return max(0, cooldown + jitter)
  ```
- Added test coverage: half-open probe lock, stuck-probe timeout, jitter variation across endpoints, failed half-open probe reopens breaker.

### 3.2 ModelWarmupService
- New actor `ModelWarmupService` in `rings/SR-00/ModelWarmupService.swift`.
- `warmup(current:candidates:apiKeyResolver:tier:)`:
  - Deduplicates candidates using new `Hashable` conformance on `CrossProviderModelCandidate`.
  - Filters by cost tier (free/cheap/any/premium).
  - Caps total probes to `maxTotalCandidates`.
  - Skips endpoints whose breaker is open; uses `beginProbe`/`endProbe` on half-open ones.
  - Races probes with a timeout; scores healthy candidates by observed latency and reliability.
  - Records outcomes into `ModelReliabilityService` and breaker failures into `ProviderCircuitBreaker`.
- Added a `withTimeout` helper for Swift concurrency.
- Added `ModelWarmupServiceTests.swift` with `MockHealthService` covering: keep current when best, switch to faster candidate, respect breaker open, record reliability outcomes, filter by cost tier, avoid switch below improvement threshold.

### 3.3 ModelConfigurationStore integration
- Added `@Published var isAdaptiveProviderWarmupEnabled: Bool = false` and `private(set)` `lastAdaptiveWarmupAt` / `lastAdaptiveWarmupReason`.
- Added `warmupService: ModelWarmupService` dependency.
- `setAdaptiveProviderWarmupEnabled(_:)` persists to `UserDefaults`.
- `warmupCandidates()` returns the candidate list.
- `runAdaptiveWarmup()` runs the service and updates last-run telemetry.
- Added store-level `recordSendOutcome(...)` and `recordCircuitBreakerSuccess(...)` helpers so `ChatViewModel` does not have to reach through multiple services.

### 3.4 ChatViewModel send path
- Captured `initialProvider`, `initialBaseURL`, `initialModel` before any automatic switching.
- After `runPreflightHealthCheck`, conditionally runs `modelStore.runAdaptiveWarmup()`.
- If warmup returns a better candidate, updates `activeProvider`/`activeBaseURL`/`activeModel` and shows a user banner.
- Uses the active tuple for the execute stream and outcome recording.
- Restores to the initial tuple when same-provider or cross-provider failover fails.

### 3.5 ModelsTabView UI
- Added `adaptiveWarmupSection` after `crossProviderSection`.
- Toggle "Warm up providers before sending" bound to `store.isAdaptiveProviderWarmupEnabled` with `onChange` persisting via `setAdaptiveProviderWarmupEnabled`.
- Displays `lastAdaptiveWarmupReason` and `lastAdaptiveWarmupAt`.
- "Warm up now" button runs `store.runAdaptiveWarmup()` and refreshes breaker states.

---

## 4. Trinity Gate Results

| Gate | Result |
|------|--------|
| `./build.sh` | PASS |
| `cargo run --bin clade-build` | PASS |
| `cargo test --workspace` | PASS |
| `cargo clippy --workspace` | PASS |
| `cargo run --bin clade-audit` | **0 findings** |
| `cargo run --bin clade-seal` | **SEAL VALID** |
| `cargo run --bin clade-e2e` | PASS |
| `open trios.app` + `/health` | `{"status":"ok","cdpConnected":true}` |

Note: `swift test` remains unavailable in the CommandLineTools-only environment; verification follows the clade pipeline defined in `CLAUDE.md`.

---

## 5. Files Changed

- `trios/rings/SR-00/ProviderCircuitBreaker.swift` — single-probe lock, stuck-probe timeout, deterministic jitter.
- `trios/rings/SR-00/ModelWarmupService.swift` — new warmup service.
- `trios/rings/SR-00/ModelReliabilityService.swift` — `CrossProviderModelCandidate` `Hashable`.
- `trios/rings/SR-00/ModelConfigurationStore.swift` — toggle, persistence, store-level outcome helpers, warmup wiring.
- `trios/rings/SR-02/ChatViewModel.swift` — capture initial tuple, adaptive warmup integration, banner, rollback.
- `trios/BR-OUTPUT/ModelsTabView.swift` — adaptive warmup section.
- `trios/tests/TriOSKitTests/ProviderCircuitBreakerTests.swift` — new breaker edge-case tests.
- `trios/tests/TriOSKitTests/ModelWarmupServiceTests.swift` — new warmup service tests.

---

## 6. Next-Loop Options

### Variant A — Budget / quota-aware warmup gating (recommended next)
Read provider balance, quota, or rate-limit headers during warmup and deprioritize or skip providers that are out of quota or low on credits. Add a "Low balance" badge in `ModelsTabView` and a fallback order that prefers providers with healthy budget. This closes the remaining economic failure mode: a provider may be reachable but unusable because the account is depleted.

### Variant B — User-defined provider preference order
Add drag-to-rank provider rows in `ModelsTabView`. Blend the user's explicit priority into the warmup ranking function so a preferred provider wins ties and gets a small bonus over pure TTFT. This gives power users control over routing without disabling the adaptive probe.

### Variant C — Predictive background warmup scheduling
Move warmup from the critical send path to a background poller that refreshes the top-N candidate combinations every 30-60s and caches the winner. On send, TriOS reuses the cached winner and only falls back to inline warmup if the cache is stale. This gives near-zero send latency while keeping proactive routing fresh.

---

## 7. Compliance

- **L1 TRACEABILITY:** This report closes Cycle 20 and references the plan `.claude/plans/trios-cycle20-adaptive-provider-warmup-loop-020.md`.
- **L2 GENERATION:** `BR-OUTPUT/ModelsTabView.swift` and `rings/SR-02/ChatViewModel.swift` are canon reviewable artifacts; changes were driven by spec and tests.
- **L3 PURITY:** All identifiers ASCII/English.
- **L4 TESTABILITY:** All Trinity gates passed; unit tests added for breaker edge cases and warmup service.
- **L5 IDENTITY:** UI constants preserved; no new sacred constants introduced.
- **L6 CEILING:** UI changes confined to `ModelsTabView`; `ProjectPaths.swift` / `TriosTheme.swift` unchanged.
- **L7 UNITY:** No new `.sh` scripts on the critical path.

φ² + 1/φ² = 3 | TRINITY
