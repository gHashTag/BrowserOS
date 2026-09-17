# Cycle 25 — Stale-While-Revalidate Predictive Warmup

## Context
Cycle 24 made volatility history survive restarts. Cycle 23 made TTL/interval adaptive. Cycle 22 introduced a predictive warmup cache refreshed by a background scheduler. The remaining critical weak spot is that **the send path still blocks on synchronous adaptive warmup whenever the cached winner is missing or stale**. For interactive chat, a stale but recently-valid winner is almost always better than waiting for a fresh probe race; production gateways (OpenRouter, LiteLLM, Vercel AI Gateway) deliberately use slightly stale health/latency data to avoid per-request probing.

## Goal
Eliminate synchronous probe latency on the chat send path by serving a cached winner even when it is slightly stale, while refreshing the cache asynchronously in the background.

## Weak spots addressed
1. **Synchronous warmup still blocks sends.** When the cache TTL expires, the next message pays the full probe cost.
2. **No max-staleness knob.** Cache is either fresh or ignored; there is no graceful degradation.
3. **No request coalescing.** Multiple rapid sends could each spawn independent warmup races.
4. **No UI visibility into staleness.** The user cannot see whether the current selection came from a fresh or stale cached winner.
5. **Background scheduler is periodic only.** It does not opportunistically refresh when the send path discovers a stale entry.

## Competitor patterns
- **OpenRouter** routes using provider health/latency windows (30 s outage memory, 5 min latency percentiles) rather than live probes per request; it fail-opens when quota/health data is unavailable.
- **LiteLLM** keeps a `DeploymentHealthCache` updated by background health checks and uses cooldown + latency-based routing; a safety net bypasses the filter if every deployment is unhealthy.
- **Vercel AI Gateway** supports automatic caching with TTL and provider `order`/`sort`/`models` fallbacks; `providerTimeouts` triggers fast failover without blocking on a slow provider.

## Tasks
- [ ] **1. Extend `PredictiveWarmupCache` with stale-while-revalidate**
  - Add `func winnerOrStale(tier:strictQuotaGating:maxStaleness:relativeTo:) -> (entry: CachedWarmupWinner, isStale: Bool)?`.
  - Fresh winner wins if available; otherwise a stale entry within `maxStaleness` seconds of its `expiresAt` is returned with `isStale = true`.

- [ ] **2. Add coalesced background refresh actor `PredictiveWarmupRefresher`**
  - File: `trios/rings/SR-00/PredictiveWarmupRefresher.swift`.
  - Actor holds a single in-flight `Task`.
  - `refresh()` coalesces: if a refresh is already running, return the existing task; else start one.
  - Calls `store.runAdaptiveWarmup()` and updates `lastPredictiveWarmupAt` / `lastPredictiveWarmupReason`.
  - Exposes `isRefreshing` for UI.

- [ ] **3. Wire into `ModelConfigurationStore`**
  - Add `@Published var predictiveWarmupMaxStaleness: TimeInterval` (persist to UserDefaults, default 120 s, clamp 0...600).
  - Add `func cachedOrStaleWarmupWinner(...) -> (winner: CachedWarmupWinner, isStale: Bool)?` that reuses the same breaker/quota checks as the fresh path.
  - Add `func refreshWarmupCacheInBackground()` using the refresher.
  - Add `setPredictiveWarmupMaxStaleness(_:)`.

- [ ] **4. Update `ChatViewModel.sendMessage`**
  - Replace the fresh-only cache lookup with `cachedOrStaleWarmupWinner`.
  - If the winner is stale, apply it immediately and call `refreshWarmupCacheInBackground()`.
  - If no cached/stale winner exists, fall back to synchronous `runAdaptiveWarmup()`.
  - Record volatility outcomes for both fresh and stale cached winners.
  - Add a system banner that distinguishes `[↻ stale]` from `[↻ fresh]`.

- [ ] **5. Update `ModelsTabView.adaptiveWarmupSection`**
  - Add a `Stepper` for "Max staleness" (0...600 s, step 30 s).
  - Show "Serving stale winner" indicator when `warmupServedStale` is true.
  - Show a pulsing "Refreshing in background" indicator when the refresher is active.

- [ ] **6. Tests**
  - Extend `PredictiveWarmupCacheTests.swift` — fresh winner preferred, stale within maxStaleness, stale beyond maxStaleness ignored, `isStale` flag.
  - Add `PredictiveWarmupRefresherTests.swift` — coalescing, single in-flight refresh, completion updates cache, no double refresh.
  - Extend `WarmupVolatilityTrackerTests.swift` or add a focused integration test verifying that a stale cached winner still records volatility.

- [ ] **7. Seal**
  - `bash build.sh` PASS; `cargo test --workspace` PASS; `cargo clippy --workspace` PASS; `cargo run --bin clade-audit` 0 findings; `cargo run --bin clade-seal` SEAL VALID; `cargo run --bin clade-e2e` PASS; `open trios.app` relaunched.

- [ ] **8. Report + experience save**
  - Write `.claude/plans/trios-cycle25-stale-while-revalidate-loop-025-report.md`.
  - Update `.trinity/experience.md` and create `.trinity/experience/YYYY-MM-DD_stale-while-revalidate-loop-025.json`.
  - Propose three Cycle 26 variants.

## Risks / Mitigations
- **Serving a stale broken endpoint:** The same breaker/quota checks used for fresh winners are applied to stale winners, so a recently-tripped provider is rejected. Max staleness is bounded (default 120 s).
- **UI inconsistency:** Background refresh may switch the active selection after the user already started reading the stale response. Mitigation: only the cached winner is applied at send time; the background refresh updates the cache for *future* sends, not the current active selection.
- **Rapid sends creating refresh spam:** The coalesced refresher ensures at most one background refresh is in flight at a time.

## Next-loop variants
1. **Cycle 26 — Failure-kind-aware volatility:** Record whether a cached-winner failure was auth, rate-limit, network, or context-length, and adjust TTL/interval/max-staleness per kind.
2. **Cycle 26 — Per-conversation provider/model pinning:** Let the user pin a provider/model per chat thread; warmup and failover only operate within allowed boundaries.
3. **Cycle 26 — Predictive warmup budget cap:** Track estimated probe spend and cap daily/weekly warmup probe budget, deprioritizing probes when the cap is close.
