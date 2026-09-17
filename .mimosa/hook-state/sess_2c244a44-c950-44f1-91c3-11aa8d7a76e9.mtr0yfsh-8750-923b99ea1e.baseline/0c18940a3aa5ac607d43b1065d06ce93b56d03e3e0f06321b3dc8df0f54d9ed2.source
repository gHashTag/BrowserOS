# Cycle 22 Report — Predictive Background Warmup Scheduling

**Date:** 2026-07-26  
**Branch:** `feat/zai-provider`  
**Selected variant:** A — Predictive background warmup scheduling  
**Road:** B (fix + test + experience save)

---

## 1. What was researched

### Weak spots in Cycle 21
1. **Warmup on the critical send path.** Every user message synchronously raced probes before the real request, so best-case TTFT included probe latency.
2. **No cached winner.** Consecutive messages reran the same race even though the provider landscape changes slowly.
3. **Background health polling was model-only.** It probed individual models but did not run cross-provider warmup or cache a winning endpoint.
4. **Stale winners were not detected.** A healthy endpoint from 30s ago might have tripped its breaker or depleted quota since then.
5. **UI lacked predictive indicators.** ModelsTabView only showed the last manual warmup run.
6. **Battery / offline awareness missing.** Background probes ran unconditionally.

### Competitor patterns
- **Vercel AI SDK / AI gateway** caches the fastest-model decision with a short TTL and refreshes it in the background.
- **OpenRouter** pre-probes keys and routes to the lowest-latency key, refreshing the ranking every few seconds.
- **LiteLLM router** maintains a routing strategy object updated by a background thread; callers read the current winner without blocking.
- **Anyscale/Zeph-style latency map** keeps an in-memory (endpoint, model) → latest TTFT table refreshed asynchronously.

TriOS adopted a cached-winner pattern: a background task runs adaptive warmup periodically, stores the winning `(provider, baseURL, model)` with a freshness timestamp, and the chat path reuses the cached winner when it is fresh and still allowed by the breaker/quota gates.

---

## 2. What was implemented

### New components
- `rings/SR-00/PredictiveWarmupCache.swift` — `CachedWarmupWinner` + actor cache keyed by `(costTier, strictQuotaGating)`, TTL-aware, with `invalidate()` and `invalidate(provider:baseURL:)`.
- `rings/SR-00/PredictiveWarmupScheduler.swift` — periodic background scheduler (default 300s) that calls `runAdaptiveWarmup()` and skips work when low-power mode is enabled.

### Store integration
- `ModelConfigurationStore` now owns the cache and scheduler.
- New `@Published` preference `isPredictiveWarmupEnabled` persisted under `trios.model.predictive-warmup-enabled`.
- `cachedWarmupWinner(tier:strictQuotaGating:)` validates breaker and quota gates before returning a cached endpoint.
- `runAdaptiveWarmup()` records each result into the cache.
- Lifecycle helpers: `startPredictiveWarmup()`, `stopPredictiveWarmup()`, `restartPredictiveWarmup()`, `setPredictiveWarmupEnabled(_:)`, `forcePredictiveWarmupRefresh()`.
- `applySelection(...)` was made internal so the chat path can apply a cached winner.

### Chat path reuse
- `ChatViewModel.sendMessage` checks the cache before the synchronous warmup when both adaptive and predictive warmups are enabled.
- If a fresh cached winner differs from the current selection, it applies it and shows the same "[↻] reason" banner used by manual warmup.
- If the cache is stale or disallowed, it falls back to live probes.

### UI
- `ModelsTabView.adaptiveWarmupSection` gained:
  - "Predictive background warmup" toggle.
  - Background warmup reason and relative timestamp.
  - "Refresh background warmup" button.

### Tests
- `tests/TriOSKitTests/PredictiveWarmupCacheTests.swift` — TTL expiry, tier/gating isolation, invalidation, replacement.
- `tests/TriOSKitTests/PredictiveWarmupSchedulerTests.swift` — start/stop, force refresh, low-power skip, disabled skip, cancellation.

---

## 3. Trinity gate results

| Gate | Result |
|------|--------|
| `./build.sh` | PASS (chat integration tests PASS) |
| `cargo test --workspace` | PASS |
| `cargo clippy --workspace` | PASS |
| `cargo run --bin clade-audit` | **0 findings** |
| `cargo run --bin clade-seal` | **SEAL VALID** |
| `cargo run --bin clade-e2e` | PASS |
| `open trios.app` / `/health` | `{"status":"ok","cdpConnected":true}` |

`swift test` is unavailable in the CommandLineTools-only environment; verification uses the clade pipeline per `CLAUDE.md`.

---

## 4. Next-loop variants

### Variant A — Adaptive warmup interval and staleness tuning
Expose the predictive warmup interval and cache TTL in Settings, and auto-shrink TTL when provider health is volatile (e.g., after a cached winner fails, reduce TTL from 45s to 15s for the next few cycles).

### Variant B — Per-conversation model pinning
Allow the user to pin a model per chat thread. Predictive warmup would still run, but it would only suggest candidates within the allowed provider/model set for that conversation, preventing a background winner from silently switching contexts.

### Variant C — Winner telemetry and feedback loop
Record whether a cached winner actually succeeded on the real send (success, latency, TTFT, failure kind). Use the outcome to tune cache TTL and ranking weights so the background scheduler learns which winners are reliable and which need faster refresh.

---

## 5. Notes and follow-ups

- Predictive warmup is off by default and requires adaptive warmup to be enabled.
- Cache TTL defaults to 45s; scheduler interval defaults to 300s. Both are hardcoded in this cycle and can be made user-configurable under Variant A.
- The chat path still validates breaker/quota state before reusing a cached winner, so stale entries never bypass safety gates.
- The scheduler currently skips only on low-power mode. Network reachability is handled by the warmup probes failing fast and updating the circuit breaker.
