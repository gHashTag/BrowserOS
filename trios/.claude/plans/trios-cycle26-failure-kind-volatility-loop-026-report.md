# Cycle 26 Report — Failure-Kind-Aware Volatility Learning

## Summary

Cycle 26 extends the TriOS adaptive warmup cache so it learns *how* a cached winner fails, not just *that* it fails. Prior cycles shrank TTL and refresh interval based on a binary success/failure rate. This cycle classifies failures as auth, balance, rate-limit, gateway, connection, timeout, model-unavailable, context-length, or unknown, and uses the classified kind to drive kind-specific cooldowns, volatility weights, and staleness policy. The result is a cache that survives transient blips (rate limits, short gateway hiccups) while quickly discarding winners that hit persistent/account-level problems (auth, balance, context-length).

## Weak spots researched

1. **Binary volatility ignored failure severity.** A single auth failure was weighted the same as a transient 503, even though retrying auth is usually futile for minutes.
2. **SSE `isBalanceError` precedence bug.** Any HTTP 400 body containing no balance wording was classified as balance because `status == 400 || status == 403 && body...` binds `&&` before `||`.
3. **No context-length failure classification.** Long prompts could be rejected as generic 400s and trigger model failover or cross-provider failover, even though another provider would reject the same context.
4. **Retry-After ignored HTTP-date form.** Some providers send an absolute date; only numeric seconds were parsed.
5. **Stale-while-revalidate served winners after severe failures.** A cached winner that just hit a balance or auth error could still be served stale because max-staleness was global.
6. **Predictive scheduler interval did not react at runtime.** A long fixed interval could persist after a severe kind was recorded, delaying recovery probes.
7. **Health probes discarded classified failure kinds.** `ModelHealthResult` only carried `.health`, so breaker failures from probes fell back to string-substring classification.

## Competitor patterns

- **LiteLLM `AllowedFailsPolicy`** lets operators set per-failure-kind cooldowns (e.g., rate-limit vs. content-moderation), treating not all failures as equal.
- **OpenRouter** distinguishes provider-level outages from model-level errors and avoids failing over for context-length/model-not-found by surfacing native error codes.
- **Vercel AI Gateway** supports `providerTimeouts` and ordered `providers`; transient failures retry inside the gateway while account/balance errors short-circuit.

These patterns justify classifying failures before deciding cooldown, failover eligibility, and cache TTL.

## Implementation

### 1. `TransportError` classification fixes

`trios/rings/SR-01/SSETransport.swift`:
- Fixed `isBalanceError` precedence with an explicit `guard` so only 400/403 with balance wording is a balance error.
- Added `isContextLengthError` detecting 413 and 400/429 bodies with `context_length_exceeded`, `maximum context length`, `too many tokens`, etc.
- Expanded `isAuthError` to 403 bodies with auth/key wording, while guarding against balance first.
- Added `SSETransport.parseRetryAfter(_:)` that parses numeric seconds and HTTP-date (RFC 7231) forms.
- Updated `isEligibleForCrossProviderFailover` to exclude context-length errors.

### 2. `ProviderCircuitBreakerFailureKind` extension

`trios/rings/SR-00/ProviderCircuitBreaker.swift`:
- Added `.contextLength` case with display name and `isTransient = false`.
- Added `volatilityWeight` (0.0 for auth/balance/context-length, 0.5 for transient, 0.75 for unknown/model-unavailable) for the volatility tracker.
- Added kind-specific cooldown for `.contextLength`.
- Reordered `TransportError.circuitBreakerFailureKind` so context-length is detected before it is misclassified as invalid-model.

### 3. `ModelHealthResult` carries failure metadata

`trios/rings/SR-00/ModelHealthService.swift`:
- Added `failureKind: ProviderCircuitBreakerFailureKind?` and `retryAfter: TimeInterval?` to `ModelHealthResult`.
- `probeCloud` now sets explicit failure kinds for 401/403 (auth), 402 (balance), 404/422 (modelUnavailable), 413 (contextLength), 429 (rateLimit), 502/503/504 (gateway), network/timeout.
- Parses `Retry-After` via `SSETransport.parseRetryAfter` for all non-2xx responses.

### 4. Warmup probe path uses classified results

`trios/rings/SR-00/ModelWarmupService.swift`:
- Timeout fallback now records `.timeout` as the failure kind.
- Records breaker failures using `healthResult.failureKind ?? healthResult.health.circuitBreakerFailureKind` and passes through `healthResult.retryAfter`.

### 5. Kind-aware volatility tracker

`trios/rings/SR-00/WarmupVolatilityTracker.swift`:
- `Outcome.failure` now carries `ProviderCircuitBreakerFailureKind`.
- `Window` keeps per-kind failure counts and trims them proportionally.
- Added `failureRate(for:candidate:)`, `dominantFailureKind(for:)`.
- Added `recommendedMaxStaleness(baseMaxStaleness:for:)` — severe kinds shrink allowed staleness toward zero.
- `recommendedTTL` and `recommendedInterval` now multiply the failure-rate scale by the average `volatilityWeight` of recorded failures.
- Persistence uses counts + kind map instead of a `[Bool]` snapshot; old `[Bool]` records still decode for migration.

`trios/rings/SR-00/VolatilityHistoryStore.swift`:
- Bumped `WarmupVolatilityRecord.currentVersion` to 2.
- Added `successes`, `failures`, `failureKinds` fields while keeping optional `outcomes` for backward decoding.

### 6. Store and send-path integration

`trios/rings/SR-00/ModelConfigurationStore.swift`:
- `recordCachedWinnerOutcome(success:candidate:kind:)` records classified failures; severe kinds trigger a runtime predictive-warmup restart if the recommended interval drops by ≥10 s.
- `cachedOrStaleWarmupWinner` now consults `volatilityTracker.recommendedMaxStaleness` per candidate and rejects stale service when volatility disables it.

`trios/rings/SR-00/PredictiveWarmupCache.swift`:
- Added `staleness(relativeTo:)` helper used by the store to enforce the per-candidate volatility ceiling.

`trios/rings/SR-02/ChatViewModel.swift`:
- On failure, extracts `transportError.circuitBreakerFailureKind` and passes it to `recordCachedWinnerOutcome`.
- Added a user-facing context-length error message branch in `formatRequestError`.

`trios/BR-OUTPUT/ModelsTabView.swift`:
- Added `.contextLength` to the circuit-breaker detail label switch.

### 7. Tests

- `tests/TriOSKitTests/ChatFailureTests.swift`: context-length detection, HTTP-date Retry-After, auth/balance precedence, context-length excluded from cross-provider failover.
- `tests/TriOSKitTests/ProviderCircuitBreakerTests.swift`: context-length kind mapping, persistent cooldown, failover eligibility.
- `tests/TriOSKitTests/ModelHealthServiceTests.swift`: 429 Retry-After numeric, 401 auth kind, 413 context-length kind.
- `tests/TriOSKitTests/WarmupVolatilityTrackerTests.swift`: severe-kind TTL shrink, dominant kind, staleness disabled for severe kinds, kind-count persistence/load.
- `tests/TriOSKitTests/VolatilityHistoryStoreTests.swift`: kind-aware record round-trip.

## Files changed

- `trios/rings/SR-01/SSETransport.swift`
- `trios/rings/SR-00/ProviderCircuitBreaker.swift`
- `trios/rings/SR-00/ModelHealthService.swift`
- `trios/rings/SR-00/ModelWarmupService.swift`
- `trios/rings/SR-00/WarmupVolatilityTracker.swift`
- `trios/rings/SR-00/VolatilityHistoryStore.swift`
- `trios/rings/SR-00/ModelConfigurationStore.swift`
- `trios/rings/SR-00/PredictiveWarmupCache.swift`
- `trios/rings/SR-02/ChatViewModel.swift`
- `trios/BR-OUTPUT/ModelsTabView.swift`
- `trios/tests/TriOSKitTests/ChatFailureTests.swift`
- `trios/tests/TriOSKitTests/ProviderCircuitBreakerTests.swift`
- `trios/tests/TriOSKitTests/ModelHealthServiceTests.swift`
- `trios/tests/TriOSKitTests/WarmupVolatilityTrackerTests.swift`
- `trios/tests/TriOSKitTests/VolatilityHistoryStoreTests.swift`
- `.claude/plans/trios-cycle26-failure-kind-volatility-loop-026.md`
- `.claude/plans/trios-cycle26-failure-kind-volatility-loop-026-report.md`

## Validation

| Gate | Result |
|------|--------|
| `bash build.sh` | **PASS** — Swift integration tests (ChatSSEEndToEnd) pass; XCTest skipped because this toolchain has no XCTest |
| `cargo test --workspace` | **PASS** — all Rust workspace tests pass |
| `cargo clippy --workspace` | **PASS** — clean |
| `cargo run --bin clade-audit` | **0 findings** across all hard gates |
| `cargo run --bin clade-seal` | **SEAL VALID** |
| `cargo run --bin clade-e2e` | **PASS** |
| `bash e2e/trios_e2e_flow.sh` | **PASS** |
| `open trios.app` + `/health` | `{"status":"ok","cdpConnected":true}`, menu-bar logo present |

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Misclassification of 400 errors as balance/context-length | Classification is body-wording gated; precedence order checks context-length before invalid-model and balance before auth. |
| Auth/balance failures shrink cache too aggressively for the whole window | Window trim removes oldest entries; a single success after a severe failure starts relaxing TTL immediately. |
| Per-kind weights are heuristic | Weights are conservative (auth/balance/context-length = 0.0, transient = 0.5, unknown = 0.75) and only affect cache policy, not user-visible routing. |
| Schema bump drops old volatility history | Old records decode via fallback counters and are treated as `.unknown`; no data loss, only loss of per-kind detail. |

## L1–L7 compliance

- **L1 TRACEABILITY** — Cycle 26 plan/report pair created; no external issue number required for this standing-cycle task.
- **L2 GENERATION** — New canon files generated/reviewed; hand edits limited to the planned ring surface.
- **L3 PURITY** — All identifiers ASCII-only; no non-English source strings.
- **L4 TESTABILITY** — Build, workspace tests, clippy, audit, seal, e2e, and app health all pass.
- **L5 IDENTITY** — No φ constants changed.
- **L6 CEILING** — UI detail added through `ModelsTabView` existing switch; no new color/path constants.
- **L7 UNITY** — No new shell scripts on the critical path.

## Next-loop variants for Cycle 27

1. **Adaptive probe budget and cost-aware warmup** — Track estimated spend per warmup run and per provider, cap daily/weekly probe budget, and shrink candidate pool or disable background refreshes when the budget is tight. Pair with Cycle 25 stale-while-revalidate to avoid burning probes on entries that are likely stale anyway.

2. **Per-conversation provider/model pinning** — Let the user pin a provider and/or model per chat thread. Adaptive warmup and cross-provider failover then operate only within the pinned boundary, giving deterministic behavior for important threads while keeping automatic routing for general chats.

3. **Provider-level health scorecard and automatic blacklist** — Aggregate health-probe and real-request outcomes into a persistent per-(provider, baseURL) reliability scorecard. Automatically deprioritize or blacklist providers whose EMA reliability drops below a threshold, and surface the score in the Models tab as a ranked fallback list.

---

**φ² + 1/φ² = 3 | TRINITY**
