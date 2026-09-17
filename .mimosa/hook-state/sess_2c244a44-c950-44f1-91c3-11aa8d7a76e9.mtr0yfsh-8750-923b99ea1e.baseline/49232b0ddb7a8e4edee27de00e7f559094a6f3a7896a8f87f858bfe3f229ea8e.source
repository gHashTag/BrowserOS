# Cycle 20 Plan — Adaptive Parallel Provider Warmup (Live-TTFT Routing)

## Context
Cycle 19 hardened cross-provider failover with a per-provider circuit breaker, `Retry-After` honoring, per-tuple unhealthy tracking, and toggle gating. Failover still relies primarily on historical reliability/latency EMA scores. Live conditions can change faster than EMA updates, so a provider that was fast yesterday may be slow or down right now.

## Weak Spots Identified
1. **Historical EMA lags live health.** `ModelReliabilityService` ranks by learned reliability × latency. A provider can degrade and still be chosen because its EMA is high.
2. **Sequential live probes waste requests.** `selectFirstHealthyCrossProviderModel()` probes the top-ranked candidate, and only tries the next after the first fails. Each failed probe is a paid/expensive round-trip.
3. **Preflight only checks the current model.** `runPreflightHealthCheck` does not compare providers; if the current provider is slow but alive, TriOS stays there.
4. **Half-open breaker allows probe races.** `canSend` returns `true` for `halfOpen`, so multiple concurrent requests may all become probes.
5. **No jitter in recovery.** All endpoints recover at deterministic cooldown boundaries, risking synchronized retry storms.
6. **No user control over warmup cost.** Probes are tiny but still paid; users cannot disable live probing or cap it.
7. **No warmup result is remembered.** A probe that succeeds is not recorded as an outcome, so the reliability scorecard misses a positive signal.

## Competitor Patterns Adopted
- **LiteLLM latency-based routing** — tracks observed latency and routes to the deployment with the lowest recent latency; supports `cooldowns` and `routing_strategy`.
- **OpenRouter provider preferences** — users/providers can express ordering and exclusion; unstable providers are deprioritized but retained.
- **Portkey.ai fallback + load balancing** — parallel health checks across endpoints, routing to the first healthy one, with fallback chains.
- **Envoy outlier detection** — ejects unhealthy hosts after consecutive failures, with jittered ejection time and success-rate-based recovery.
- **resilient-llm / adaptive routers** — race small probes, pick lowest TTFT, record probe outcomes.

## Three Variants

### Variant A — Adaptive parallel provider warmup (recommended)
Before sending the user message, race lightweight probes across all eligible (provider, model) candidates that pass circuit-breaker and cost-tier filters. Pick the candidate with the lowest live latency/TTFT. Record the warmup outcome in the reliability scorecard. Add a user toggle and a max-probe budget. Fix half-open probe races with a single-probe lock and add jittered recovery.

**Pros:** Closes the live-lag gap; reuses existing `ModelHealthService.probe`; directly improves both predictive selection and failover; bounded cost.  
**Cons:** Adds latency to the first chat send (probe race); probes cost real tokens; needs careful UX to avoid confusion.  
**Complexity:** Medium.

### Variant B — Half-open single-probe lock + jittered backoff + breaker persistence
Harden the existing circuit breaker: add a `probing` state so only one request can pass in half-open, add jitter to `nextAllowedAt`, and persist breaker state across app launches via `MemoryStore`/JSON.

**Pros:** Smaller surface; improves the most subtle correctness issues in Cycle 19.  
**Cons:** Does not address the larger live-lag problem; persistence adds schema work.  
**Complexity:** Medium-Low.

### Variant C — Cost-capped warmup with budget awareness
Extend warmup to read provider balance/quota headers and skip providers that are near depletion. Add a per-turn probe token budget and surface estimated probe cost in the UI.

**Pros:** Prevents surprise charges; aligns with user cost tier.  
**Cons:** Balance header support is provider-specific and often missing; complexity high for marginal gain.  
**Complexity:** Medium-High.

## Recommended Variant
**Variant A.** It is the natural next step after Cycle 19: the breaker tells us *who is allowed*, but live probes tell us *who is fastest right now*. It also fixes two Cycle 19 correctness issues (half-open races and jitter) as part of the same routing improvement. This cycle will implement Variant A.

## Task Breakdown
1. **Harden `ProviderCircuitBreaker` (foundational):**
   - Add a `probing` flag/lock so only one caller can pass through a half-open endpoint at a time.
   - Add jitter to `computeCooldown` so recovery windows are spread.
2. **Create `ModelWarmupService` in `rings/SR-00/ModelWarmupService.swift`:**
   - Accept a list of candidates, run `healthService.probe` in parallel via `withTaskGroup`.
   - Filter by `circuitBreaker.canSend` and cost tier.
   - Score results by health first, then latency (lower is better).
   - Record successful probes into `ModelReliabilityService`.
   - Respect a max concurrency/budget and a timeout.
3. **Extend `ModelConfigurationStore`:**
   - Add `@Published var isAdaptiveProviderWarmupEnabled: Bool` (persisted).
   - Add `warmupCandidates(...)` building the candidate list from current provider fallback models + cross-provider fallbacks.
   - Add `runAdaptiveWarmup(...)` returning the best candidate or `nil`.
   - Gate predictive selection and failover to use warmup when enabled.
4. **Update `ChatViewModel.sendMessage`:**
   - After preflight but before `executeStream`, run warmup if enabled.
   - Apply the winning candidate; show a system banner when a live-warmup switch occurs.
   - Record the final send outcome and breaker success/failure as before.
5. **Update `BR-OUTPUT/ModelsTabView.swift`:**
   - Add a toggle "Live provider warmup" in the smart-selection/cross-provider section.
   - Show last warmup result/winner and probe count.
6. **Add tests:**
   - `tests/TriOSKitTests/ModelWarmupServiceTests.swift` — race, scoring, cost-tier filtering, breaker gating.
   - Update `ProviderCircuitBreakerTests.swift` — probing lock, jitter.
7. **Run Trinity gates and fix regressions.**
8. **Save experience and write final report.**

## Test Plan
- Unit: warmup picks the lowest-latency healthy candidate; skips circuit-open providers; skips cost-tier mismatches; records successful probes.
- Unit: breaker half-open allows only one probe at a time; jitter spreads recovery times.
- Integration: chat e2e still passes (warmup toggle off by default in tests).
- Gates: build, cargo test, clippy, clade-audit, clade-seal, clade-e2e, app relaunch + `/health`.

## Gate Checklist
- [ ] `bash build.sh` passes (chat integration tests pass)
- [ ] `cargo run --bin clade-build` passes
- [ ] `cargo test --workspace` passes
- [ ] `cargo clippy --workspace` passes
- [ ] `cargo run --bin clade-audit` 0 findings
- [ ] `cargo run --bin clade-seal` SEAL VALID
- [ ] `cargo run --bin clade-e2e` passes
- [ ] `open trios.app` relaunched and `/health` returns ok
- [ ] No new `*.sh` on critical path (L7 UNITY)

## Risks
- **Probe cost:** each warmup issues paid tiny requests. Mitigate with toggle off by default, max concurrency, and clear UX.
- **First-send latency:** the send is delayed by the probe race. Mitigate with a short probe timeout and fallback to historical ranking if warmup times out.
- **Thundering herd on recovery:** mitigated by half-open single-probe lock and jitter.
- **Swift 6 concurrency:** ensure `ModelWarmupService` and breaker lock are `Sendable`/actor-safe.

## Next-Loop Options (post-Cycle-20)
1. **Account/budget-aware failover** — read balance/quota headers and avoid out-of-quota providers.
2. **User-defined provider preference order + re-home on recovery** — drag-to-rank providers and switch back when healthy.
3. **Persistent circuit-breaker state** — store breaker entries in `MemoryStore`/JSON to survive app restart.

---
φ² + 1/φ² = 3 | TRINITY
