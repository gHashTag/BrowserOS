# Cycle 23 Plan — Adaptive Warmup Interval and Staleness Tuning

**Date:** 2026-07-26  
**Branch:** `feat/zai-provider`  
**Selected variant:** A (from Cycle 22 options)  
**Road:** B — fix + test + experience save

---

## 1. Weak spots in Cycle 22

1. **Cache TTL is shorter than the scheduler interval.** `PredictiveWarmupCache` defaults to a 45s TTL, while `PredictiveWarmupScheduler` refreshes only every 300s. The cache therefore expires ~6 times before the next background refresh, forcing the chat path to fall back to synchronous probes on almost every send.
2. **TTL and interval are hardcoded.** Users and deployments cannot tune the trade-off between freshness and probe cost.
3. **No adaptation to provider volatility.** A stable provider landscape should use a longer TTL and slower refresh; a flaky landscape needs a shorter TTL and faster refresh. The current system uses fixed constants regardless of recent failure rate.
4. **No user-visible cache freshness indicator.** `ModelsTabView` shows when the last background refresh ran, but not when the cached winner itself expires or whether it is still fresh.
5. **Chat-path fallback does not inform the scheduler.** When the cache is stale and the chat path runs live warmup, the result is cached, but the scheduler continues to wait up to 300s for its next refresh.
6. **No feedback loop from real sends.** Whether a cached winner succeeded or failed on the actual request is not recorded, so the warmup system cannot learn which winners are reliable.

---

## 2. Competitor patterns

- **OpenRouter** caches responses with a default 300s TTL, configurable per request via `X-OpenRouter-Cache-TTL` (1–86,400s). It also supports cache invalidation and sticky routing to keep provider-side prompt caches warm.
- **Vercel AI SDK ResponseCache** exposes a configurable TTL (5–30 min for conversations, 1–4 h general default, 12–48 h for facts). It emits `cache_hit` / `cache_miss` events and supports LRU/LFU eviction.
- **LiteLLM** has a hardcoded 300s prompt-cache affinity TTL that users want configurable; the general cache supports per-request `ttl` and invalidation.
- **CDN / HTTP cache semantics** use `max-age` plus `stale-while-revalidate`: serve a stale entry while refreshing asynchronously. TriOS can adopt the spirit of this pattern by allowing a configurable TTL and an independent refresh interval.

TriOS will make the warmup cache TTL and scheduler interval configurable and adaptive: a volatility tracker observes recent cached-winner outcomes and shrinks TTL/interval when winners fail, while lengthening them when winners are stable.

---

## 3. Decomposed implementation tasks

### Task 1 — Volatility tracking model ✅
- Add `WarmupVolatilityTracker` actor in `rings/SR-00/WarmupVolatilityTracker.swift`.
- Track the last N cached-winner outcomes (success/failure) keyed by `(provider, baseURL, model)`.
- Provide `record(_:for:)`, `failureRate(for:)`, `recommendedTTL(baseTTL:for:)`, `recommendedInterval(baseInterval:for:)`.
- Bounded rolling window; TTL shrinks linearly with failure rate, interval shrinks more aggressively.

### Task 2 — Configurable cache TTL and scheduler interval ✅
- `PredictiveWarmupCache.record(...)` accepts per-record `ttl`; added `remainingTTL(...)`.
- `PredictiveWarmupScheduler.restart(interval:)` updates cadence.
- `ModelConfigurationStore` exposes `@Published` TTL/interval persisted to UserDefaults.
- Defaults: TTL 60s, interval 60s.

### Task 3 — Store integration ✅
- `setPredictiveWarmupTTL(_:)` / `setPredictiveWarmupInterval(_:)` added with persistence and clamping.
- `WarmupVolatilityTracker` injected into `ModelConfigurationStore`.
- `runAdaptiveWarmup()` records volatility-adjusted TTL.
- `restartPredictiveWarmup()` uses volatility-adjusted interval.
- Cached-winner helper methods exposed for UI and chat path.

### Task 4 — Chat-path outcome feedback ✅
- `ChatViewModel.sendMessage` captures the cached winner candidate.
- Records success after a completed stream; records failure on non-cancellation errors.

### Task 5 — UI controls and freshness indicator ✅
- `ModelsTabView` steppers for TTL (15–300s) and interval (15–600s).
- Displays remaining cached-winner TTL and recent failure rate.
- "Refresh background warmup" refreshes stats as well.

### Task 6 — Tests ✅
- `WarmupVolatilityTrackerTests.swift` added.
- `PredictiveWarmupCacheTests.swift` extended with `remainingTTL` and per-record TTL tests.
- `PredictiveWarmupSchedulerTests.swift` extended with restart test.
- `ModelConfigurationStore` integration covered indirectly; persistence exercised via new defaults path.

### Task 7 — Trinity gates ✅
- `bash build.sh` PASS
- `cargo test --workspace` PASS
- `cargo clippy --workspace` PASS
- `cargo run --bin clade-audit` 0 findings
- `cargo run --bin clade-e2e` PASS
- `cargo run --bin clade-seal` SEAL VALID
- `open trios.app` relaunched

---

## 4. Files to touch

- `trios/rings/SR-00/WarmupVolatilityTracker.swift` — new.
- `trios/rings/SR-00/PredictiveWarmupCache.swift` — accept per-record TTL.
- `trios/rings/SR-00/PredictiveWarmupScheduler.swift` — restart with new interval, apply interval.
- `trios/rings/SR-00/ModelConfigurationStore.swift` — TTL/interval preferences, volatility tracker injection, adaptive recording.
- `trios/rings/SR-02/ChatViewModel.swift` — record cached-winner outcomes after send.
- `trios/BR-OUTPUT/ModelsTabView.swift` — TTL/interval controls, freshness/adaptive UI.
- `trios/tests/TriOSKitTests/WarmupVolatilityTrackerTests.swift` — new.
- `trios/tests/TriOSKitTests/PredictiveWarmupCacheTests.swift` — extend.
- `trios/tests/TriOSKitTests/PredictiveWarmupSchedulerTests.swift` — extend.
- `trios/.claude/plans/trios-cycle23-adaptive-warmup-interval-loop-023.md`
- `trios/.claude/plans/trios-cycle23-adaptive-warmup-interval-loop-023-report.md`
- `trios/.trinity/experience/2026-07-26_adaptive-warmup-interval-loop-023.json`
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
- Unit tests cover: volatility tracker TTL/interval adaptation, per-record cache TTL, scheduler restart, TTL/interval persistence.

---

## 6. Next-loop options (to be finalized in report)

1. **Per-conversation model pinning** — allow the user to pin a provider/model per chat thread so predictive warmup only suggests within allowed boundaries.
2. **Winner telemetry dashboard** — persist cached-winner outcomes to agent-memory and surface per-provider win-rate / stale-rate stats in the Models tab.
3. **Stale-while-revalidate semantics** — serve a slightly stale cached winner while asynchronously refreshing it in the background, eliminating any synchronous probe latency.
