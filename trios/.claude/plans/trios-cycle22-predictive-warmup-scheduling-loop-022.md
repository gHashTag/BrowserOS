# Cycle 22 Plan — Predictive Background Warmup Scheduling

**Date:** 2026-07-26  
**Branch:** `feat/zai-provider`  
**Selected variant:** A (from Cycle 21 options)  
**Road:** B — fix + test + experience save

---

## 1. Weak spots in Cycle 21

1. **Warmup runs on the critical send path.** Every user message triggers `ModelWarmupService.warmup`, which races probes synchronously before the real request. Even when probes are cheap (`max_tokens:1`), the best-case TTFT includes probe latency plus the real request's TTFT.
2. **No cached winner.** If the user sends several messages in a row, each send reruns the same race even though the provider landscape rarely changes between seconds.
3. **Background health polling is model-only.** `BackgroundHealthPoller` probes every known model but does not run provider-level warmup or cache a cross-provider winner.
4. **Stale winners are not detected.** A provider that was healthy 30 seconds ago may have tripped its circuit breaker or depleted its quota since the last warmup, but the chat path has no cheap way to know without rerunning probes.
5. **UI shows "last warmup" only for manual runs.** There is no indicator that warmup is running automatically in the background or when the cached winner will expire.
6. **Battery / offline awareness missing.** Background probes run unconditionally when warmup is enabled, even when the Mac is on battery or offline.

---

## 2. Competitor patterns

- **Vercel AI SDK / AI gateway** caches "fastest model" decisions for a short TTL and re-evaluates in the background so the chat path is a single upstream call.
- **OpenRouter load balancing** pre-probes keys and routes to the key with the lowest recent latency, refreshing the ranking every few seconds.
- **LiteLLM router** maintains a "routing strategy" object that is updated by a background thread; callers read the current winner without blocking.
- **Anyscale/Zeph-style** "latency map" keeps an in-memory table of (endpoint, model) → latest TTFT and refreshes it asynchronously; the request path does an O(1) lookup.

TriOS will adopt a cached-winner pattern: a background task runs adaptive warmup periodically, stores the winning `(provider, baseURL, model)` plus a freshness timestamp, and the chat path reuses the cached winner when it is fresh and still allowed by the breaker/quota gates.

---

## 3. Decomposed implementation tasks

### Task 1 — Cached warmup result model
- Add `CachedWarmupWinner` struct: `selected: CrossProviderModelCandidate`, `computedAt: Date`, `expiresAt: Date`, `reason: String`.
- Add `isFresh(relativeTo:)` helper using a configurable TTL.
- Add `ProviderEndpointKey` validation helper to confirm the cached endpoint still passes `circuitBreaker.canSend` and quota gating.

### Task 2 — Warmup cache service
- Add `PredictiveWarmupCache` actor in `rings/SR-00/PredictiveWarmupCache.swift`.
- APIs: `record(_:)`, `winner(for tier:strictQuotaGating:) -> CachedWarmupWinner?`, `invalidate()`, `invalidate(for provider:baseURL:)`.
- Key by cost tier + strict-gating flag so changing either produces independent caches.
- TTL default 45s; configurable via init.

### Task 3 — Background warmup scheduler
- Add `PredictiveWarmupScheduler` actor in `rings/SR-00/PredictiveWarmupScheduler.swift`.
- Owns a periodic `Task` that calls `ModelConfigurationStore.runAdaptiveWarmup()` and writes the result into `PredictiveWarmupCache`.
- Respects `ProcessInfo.isLowPowerModeEnabled` and network reachability (skip on low power or when no eligible providers can be reached).
- Interval default 60s; configurable.
- Provides `start()`, `stop()`, `forceRefresh()`.

### Task 4 — Store integration
- Inject `PredictiveWarmupCache` into `ModelConfigurationStore`.
- Add `isPredictiveWarmupEnabled: Bool` `@Published` preference, persisted via `UserDefaults` under `trios.model.predictive-warmup-enabled`.
- Add `predictiveWarmupInterval: TimeInterval` preference, persisted under `trios.model.predictive-warmup-interval` (default 60).
- Add `cachedWarmupWinner(for tier:strictQuotaGating:) -> CachedWarmupWinner?` helper that validates breaker + quota state.
- Add `startPredictiveWarmup()`, `stopPredictiveWarmup()`, `forcePredictiveWarmupRefresh()`.
- Wire scheduler lifecycle into `init`, provider/baseURL/key changes (invalidate cache and restart), and app foreground assumptions.

### Task 5 — Chat path cache reuse
- In `ChatViewModel.sendMessage`, when `isAdaptiveProviderWarmupEnabled`:
  - First check `modelStore.cachedWarmupWinner(tier: preferredCostTier, strictQuotaGating: isStrictQuotaGatingEnabled)`.
  - If fresh and allowed, apply the cached selection and skip synchronous warmup.
  - If missing, stale, or not allowed, fall back to `runAdaptiveWarmup()` and update the cache.
- Record a banner/message only when the cache causes a switch (same UX as manual warmup).

### Task 6 — UI indicators
- In `ModelsTabView.adaptiveWarmupSection`:
  - Add a "Predictive background warmup" toggle under the adaptive warmup section.
  - Show "cached winner" row when a fresh winner exists: provider name, model, relative freshness.
  - Show "next refresh in ..." countdown derived from `expiresAt`.
  - Add a "Refresh cache now" button.

### Task 7 — Tests
- Add `PredictiveWarmupCacheTests.swift` (new): TTL expiry, tier/gating isolation, invalidate, freshness.
- Add `PredictiveWarmupSchedulerTests.swift` (new): start/stop, force refresh records a winner, low-power skip.
- Extend `ModelConfigurationStoreTests.swift` (or create if missing) to verify cache reuse and invalidation on endpoint change.
- Extend `ChatViewModel` tests (or mock-based tests) to verify cached winner bypasses synchronous warmup.

### Task 8 — Trinity gates
- Run `./build.sh`, `cargo test --workspace`, `cargo clippy --workspace`, `clade-audit`, `clade-seal`, `clade-e2e`, relaunch `trios.app`.

---

## 4. Files to touch

- `trios/rings/SR-00/PredictiveWarmupCache.swift` — new.
- `trios/rings/SR-00/PredictiveWarmupScheduler.swift` — new.
- `trios/rings/SR-00/ModelConfigurationStore.swift` — cache/scheduler injection, preferences, helpers.
- `trios/rings/SR-02/ChatViewModel.swift` — use cached winner before synchronous warmup.
- `trios/BR-OUTPUT/ModelsTabView.swift` — predictive toggle, cached winner display, refresh button.
- `trios/tests/TriOSKitTests/PredictiveWarmupCacheTests.swift` — new.
- `trios/tests/TriOSKitTests/PredictiveWarmupSchedulerTests.swift` — new.
- `trios/.claude/plans/trios-cycle22-predictive-warmup-scheduling-loop-022.md`
- `trios/.claude/plans/trios-cycle22-predictive-warmup-scheduling-loop-022-report.md`
- `trios/.trinity/experience/2026-07-26_predictive-warmup-scheduling-loop-022.json`
- `trios/.trinity/experience.md`

---

## 5. Success criteria

- `./build.sh` PASS
- `cargo test --workspace` PASS
- `cargo clippy --workspace` PASS
- `cargo run --bin clade-audit` hard gates 0 findings
- `cargo run --bin clade-seal` SEAL VALID
- `cargo run --bin clade-e2e` PASS
- `open trios.app` relaunched and `/health` ok
- Unit tests cover: cache TTL, tier/gating isolation, scheduler records winner, low-power skip, chat path cache reuse.

---

## 6. Next-loop options (to be finalized in report)

1. **User-defined provider preference order** — drag-to-rank providers in ModelsTabView and blend priority into scoring.
2. **Real-time spend dashboard** — capture usage headers, estimate per-provider spend, show running balance badges.
3. **Warmup result telemetry** — persist warmup outcomes to agent-memory and surface per-provider win-rate stats in the Models tab.
