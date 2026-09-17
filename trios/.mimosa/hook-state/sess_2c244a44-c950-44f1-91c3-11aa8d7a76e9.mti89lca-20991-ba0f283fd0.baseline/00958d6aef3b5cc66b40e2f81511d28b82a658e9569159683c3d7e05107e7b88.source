# Cycle 23 Report — Adaptive Warmup Interval and Staleness Tuning

**Date:** 2026-07-26  
**Branch:** `feat/zai-provider`  
**Road:** B — fix + test + experience save  
**Status:** LANDED

---

## 1. What was built

### 1.1 Volatility tracker (`rings/SR-00/WarmupVolatilityTracker.swift`)
- New actor tracks the last N cached-winner outcomes per `(provider, baseURL, model)`.
- Provides `record(_:for:)`, `failureRate(for:)`, `recommendedTTL(baseTTL:for:)`, and `recommendedInterval(baseInterval:for:)`.
- Bounded rolling window keeps memory constant and computation cheap.
- TTL and interval shrink linearly with failure rate; interval shrinks more aggressively (rate squared) so flaky landscapes refresh faster.

### 1.2 Configurable cache TTL and scheduler interval
- `PredictiveWarmupCache.record(...)` now accepts a per-record `ttl` while keeping the init default.
- Added `remainingTTL(...)` so the UI can show when the cached winner expires.
- `PredictiveWarmupScheduler.restart(interval:)` stops the current task, updates the interval, and restarts the loop.
- Defaults changed from 45s cache / 300s scheduler to 60s / 60s so the cache is refreshed before it expires.

### 1.3 Store integration (`rings/SR-00/ModelConfigurationStore.swift`)
- Added `@Published predictiveWarmupTTL` and `@Published predictiveWarmupInterval` with UserDefaults persistence.
- Injected `WarmupVolatilityTracker` and exposed it for tests.
- `runAdaptiveWarmup()` records cache entries with `volatilityTracker.recommendedTTL(...)`.
- `restartPredictiveWarmup()` computes `volatilityTracker.recommendedInterval(...)` from the current cached winner.
- Added `setPredictiveWarmupTTL(_:)`, `setPredictiveWarmupInterval(_:)`, `cachedWarmupRemainingTTL(...)`, `cachedWinnerFailureRate(...)`, and `recordCachedWinnerOutcome(success:candidate:)`.

### 1.4 Chat-path outcome feedback (`rings/SR-02/ChatViewModel.swift`)
- Captures the cached winner candidate when a predictive cache switch happens.
- Records success after a completed stream and failure (excluding user cancellation) on error.
- This closes the feedback loop so the warmup system learns which cached winners are reliable.

### 1.5 UI controls and freshness indicator (`BR-OUTPUT/ModelsTabView.swift`)
- Added steppers for cache TTL (15–300s) and refresh interval (15–600s).
- Shows remaining cached-winner TTL and recent failure rate.
- The "Refresh background warmup" button now also refreshes the displayed stats.

### 1.6 Tests
- `tests/TriOSKitTests/WarmupVolatilityTrackerTests.swift` — failure-rate computation, bounded window, TTL/interval adaptation, reset.
- Extended `PredictiveWarmupCacheTests.swift` — `remainingTTL`, per-record TTL override.
- Extended `PredictiveWarmupSchedulerTests.swift` — `restart(interval:)` keeps running and applies the new cadence.

---

## 2. Trinity gate results

| Gate | Result |
|------|--------|
| `bash build.sh` | PASS (Swift integration tests passed, XCTest unavailable in toolchain) |
| `cargo test --workspace` | PASS (all crates, all tests) |
| `cargo clippy --workspace` | PASS |
| `cargo run --bin clade-audit` | 0 findings across all 8 checks |
| `cargo run --bin clade-e2e` | PASS (`report_prod_*.md` generated) |
| `cargo run --bin clade-seal` | SEAL VALID |
| `open trios.app` | relaunched, menu-bar logo present |

---

## 3. Weak spots addressed / still open

### Addressed
- Cache TTL no longer expires many times between background refreshes.
- TTL and interval are user-tunable and persisted.
- System adapts to recent cached-winner volatility.
- Chat path feeds real send outcomes back into the tracker.
- UI exposes freshness and failure rate.

### Still open
- The bounded window uses approximate aging; a time-decayed EWMA could react faster to sudden provider flapping.
- Outcomes are in-memory only; a restart loses volatility history.
- There is no automatic stale-while-revalidate fallback yet.

---

## 4. Next-loop options

### Variant A — Persist volatility history to agent-memory
Move cached-winner outcomes from in-memory `WarmupVolatilityTracker` into `agent-memory.sqlite3` via `MemoryStoreReliabilityAdapter` or a new table. Survive restarts and enable cross-session learning. This is a medium-sized change with high leverage for long-term reliability.

### Variant B — Stale-while-revalidate send path
Allow `PredictiveWarmupCache` to return a slightly stale winner while `ModelConfigurationStore` asynchronously refreshes it in the background. If the stale winner fails, the already-running refresh provides a fresh fallback with zero extra user-visible latency. This is the largest change but eliminates synchronous probe latency entirely.

### Variant C — Per-conversation provider/model pinning
Add a `pinnedModel` / `pinnedProvider` field to `ChatConversation` and a toggle in the chat header. Predictive warmup and cache lookups respect the pin, so adaptive behavior stays within user-defined boundaries. Smaller change with clear UX payoff.
