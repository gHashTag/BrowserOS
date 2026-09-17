# Cycle 25 Report — Stale-While-Revalidate Predictive Warmup

## Summary

Cycle 25 closed the last major latency gap in the TriOS adaptive warmup stack. After Cycles 22–24 built a predictive warmup cache, background scheduler, adaptive TTL/interval, and persisted volatility history, the send path still fell back to synchronous provider probes whenever the cached winner expired. This cycle introduces **stale-while-revalidate service**: a slightly stale cached winner is served immediately while a single coalesced background refresh updates the cache for the next send. The result is lower perceived TTFT, fewer blocking probe races, and full visibility in the Models tab.

## Weak spots researched

1. **Synchronous warmup blocked the send path.** When `PredictiveWarmupCache` TTL expired, `ChatViewModel.sendMessage` paid the full probe cost before streaming the first token.
2. **No graceful staleness degradation.** The cache was binary: fresh or ignored. There was no knob to accept a recently-valid winner.
3. **No request coalescing for background refresh.** Multiple rapid sends could each spawn independent warmup races.
4. **No UI visibility into staleness.** The user could not see whether a switched provider came from a fresh or stale cached winner.
5. **Background scheduler was periodic only.** It did not opportunistically refresh when the send path discovered a stale entry.

## Competitor patterns

- **OpenRouter** routes using provider health/latency windows (≈30 s outage memory, 5 min latency percentiles) and fail-opens when health/quota data is unavailable rather than blocking per request.
- **LiteLLM** keeps a `DeploymentHealthCache` updated by background checks and applies cooldown + latency-based routing; a safety net bypasses filtering if every deployment is unhealthy.
- **Vercel AI Gateway** supports automatic caching with TTL and provider `order`/`sort`/`models` fallbacks; `providerTimeouts` triggers fast failover without blocking on a slow provider.

These patterns justify serving slightly stale health data to avoid per-request probe latency, provided there is a bounded staleness window and an async refresh path.

## Implementation

### 1. `PredictiveWarmupCache.winnerOrStale(...)`

`rings/SR-00/PredictiveWarmupCache.swift` gained a new accessor that returns a fresh winner if available, otherwise a stale entry within `maxStaleness` seconds of its `expiresAt` with `isStale = true`. A non-positive `maxStaleness` disables stale service, preserving the previous strict behavior.

### 2. `PredictiveWarmupRefresher` actor

New file `rings/SR-00/PredictiveWarmupRefresher.swift` holds a single in-flight `Task`. `refresh()` coalesces concurrent callers onto the same task, starts a new task only when none is running, and clears the task when `forcePredictiveWarmupRefresh()` completes. It exposes `isRefreshing` for UI observation. This prevents refresh spam and duplicate probe spend.

### 3. `ModelConfigurationStore` integration

`rings/SR-00/ModelConfigurationStore.swift`:
- Added `@Published var predictiveWarmupMaxStaleness: TimeInterval = 120` persisted via `UserDefaults` (clamped `0...600`).
- Added `cachedOrStaleWarmupWinner(tier:strictQuotaGating:maxStaleness:)` that reuses the existing breaker/quota checks for both fresh and stale entries.
- Added `cachedWarmupWinner(...)` as a strict wrapper (`maxStaleness: 0`).
- Added `isCachedWarmupWinnerStale(...)` and `isWarmupCacheRefreshing` for the UI.
- Added `refreshWarmupCacheInBackground()` and `setPredictiveWarmupMaxStaleness(_:)`.
- Stored the refresher as a `lazy var` to avoid Swift initialization-order issues.

### 4. `ChatViewModel.sendMessage` send-path wiring

`rings/SR-02/ChatViewModel.swift` now calls `cachedOrStaleWarmupWinner` instead of the fresh-only lookup. If a stale winner is served, the selection is applied immediately and `refreshWarmupCacheInBackground()` is triggered. The system banner distinguishes `[↻ stale]` from `[↻]`. If no cached or stale winner exists, the path falls back to synchronous `runAdaptiveWarmup()`. Volatility outcomes are still recorded for the served candidate.

### 5. `ModelsTabView` UI

`BR-OUTPUT/ModelsTabView.swift`:
- Added a `Stepper` for **Max staleness** (`0...600 s`, step `30 s`).
- Shows **Fresh for Ns**, **Serving stale winner** (orange), or **No fresh cached winner**.
- Shows a **Refreshing in background** indicator when the refresher is active.
- Retains the existing volatility-history indicator and failure-rate label.

### 6. Tests

- `tests/TriOSKitTests/PredictiveWarmupCacheTests.swift` extended with `winnerOrStale` coverage: prefers fresh, returns stale within window, ignores stale beyond window, disables when `maxStaleness` is zero.
- `tests/TriOSKitTests/PredictiveWarmupRefresherTests.swift` added: coalescing concurrent requests, sequential refresh starts a new task, refresh updates the cache, store-level background refresh is coalesced.

## Files changed

- `trios/rings/SR-00/PredictiveWarmupCache.swift`
- `trios/rings/SR-00/PredictiveWarmupRefresher.swift` (new)
- `trios/rings/SR-00/ModelConfigurationStore.swift`
- `trios/rings/SR-02/ChatViewModel.swift`
- `trios/BR-OUTPUT/ModelsTabView.swift`
- `trios/tests/TriOSKitTests/PredictiveWarmupCacheTests.swift`
- `trios/tests/TriOSKitTests/PredictiveWarmupRefresherTests.swift` (new)
- `.claude/plans/trios-cycle25-stale-while-revalidate-loop-025.md`
- `.claude/plans/trios-cycle25-stale-while-revalidate-loop-025-report.md`

## Validation

| Gate | Result |
|------|--------|
| `bash build.sh` | PASS — Swift integration tests (ChatSSEEndToEnd) pass |
| `cargo test --workspace` | PASS — all Rust workspace tests pass |
| `cargo clippy --workspace` | PASS — clean |
| `cargo run --bin clade-audit` | **0 findings** across all hard gates |
| `cargo run --bin clade-seal` | **SEAL VALID** |
| `cargo run --bin clade-e2e` | PASS |
| `open trios.app` + `/health` | `{"status":"ok","cdpConnected":true}`, menu-bar logo present |

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Serving a stale broken endpoint | The same breaker/quota checks used for fresh winners are applied to stale winners. `maxStaleness` is bounded (default 120 s, hard cap 600 s). |
| UI inconsistency from background refresh switching the active model mid-response | Background refresh only writes the cache for *future* sends; the current send uses the candidate selected at call time. |
| Rapid sends creating refresh spam | `PredictiveWarmupRefresher` coalesces overlapping background refreshes into a single in-flight task. |
| Stale service hides provider degradation | A stale winner still passes breaker and quota gates; a tripped provider is rejected and the path falls back to synchronous warmup. |

## L1–L7 compliance

- **L1 TRACEABILITY** — Cycle 25 plan/report pair created; no external issue number required for this standing-cycle task.
- **L2 GENERATION** — New canon files generated/reviewed; hand edits limited to the planned ring surface.
- **L3 PURITY** — All identifiers ASCII-only; no non-English source strings.
- **L4 TESTABILITY** — Build, workspace tests, clippy, audit, seal, e2e, and app health all pass.
- **L5 IDENTITY** — No φ constants changed.
- **L6 CEILING** — UI controls added through `ModelsTabView` and `ModelConfigurationStore`; theme/colors use existing `TriosTheme`/`ProjectPaths` SSOT.
- **L7 UNITY** — No new shell scripts on the critical path.

## Next-loop variants for Cycle 26

1. **Failure-kind-aware volatility** — Record whether a cached-winner failure was auth, rate-limit, network, or context-length, and adjust TTL, scheduler interval, and max staleness per kind. This makes the warmup cache more resilient to transient rate limits and stricter around auth failures.

2. **Per-conversation provider/model pinning** — Let the user pin a provider and/or model per chat thread. Adaptive warmup and cross-provider failover would then only operate within the pinned boundary, giving deterministic behavior for important threads while keeping automatic routing for general chats.

3. **Predictive warmup budget cap** — Track estimated probe spend (number of probes × model cost) and cap daily/weekly warmup budget. When the cap is close, deprioritize probes, shrink the candidate pool, or disable stale-while-revalidate background refreshes for expensive tiers.

---

**φ² + 1/φ² = 3 | TRINITY**
