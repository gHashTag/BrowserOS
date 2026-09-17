# Cycle 17 Plan: Latency-aware Model Routing

## Weak spots (Cycle 16 follow-up)
1. **Binary outcomes only** — `ModelOutcome` stores only `success`/`reason`/`timestamp`, so the reliability scorecard has no latency signal.
2. **No request-duration measurement** — `ChatViewModel` and `SSETransport` never measure how long a request or a health probe takes.
3. **No time-to-first-token (TTFT)** — streaming latency, the most user-visible metric, is not captured.
4. **Ranking ignores speed** — `rankedFallbacks` and `bestModel` sort by reliability score only; a model with 100% uptime but 30s TTFT can outrank a 95% model with 200ms TTFT.
5. **No UI visibility** — `ModelsTabView` shows health badges but no latency indicator.
6. **Health probes discard timing** — `ModelHealthService.probe` knows how long the probe took but throws it away.

## Competitor patterns
- **llm-d latency predictor** — online regression predicts TTFT and TPOT per pod; routing uses latency-SLO plugins and weighted-random picker.
- **llm-fallback-router** — maintains EWMA latency per model; `latency` strategy picks fastest, `balanced` strategy blends health score minus latency; exposes a live scoreboard.
- **OpenRouter provider routing** — `provider.sort: "latency"` and `preferred_max_latency` (p50/p75/p90/p99 seconds).
- **Zeph orchestrator** — EMA / Thompson sampling adaptive routing with cascade fallback and concurrency admission.
- **Common pattern:** combine binary success signal with EMA latency into a single composite score, then rank candidates.

## Goal for Cycle 17
Record per-request and per-probe latency (total duration and TTFT) into the existing reliability store. Blend EMA latency into the fallback/predictive ranking so fast models rise and slow models fall. Surface per-model latency in the Models tab.

## Files to touch
1. `rings/SR-00/ModelReliabilityService.swift` — add `latencyMs`/`timeToFirstTokenMs` to `ModelOutcome`; add `ModelLatency` aggregate; update `reliability()` composite score to blend success score and latency score; update `rankedFallbacks`/`bestModel` to use composite score.
2. `rings/SR-00/ModelConfigurationStore.swift` — update `recordSendOutcome` and `recordHealthOutcome` signatures to accept optional latency; update call sites in `refreshHealth()`.
3. `rings/SR-02/ChatViewModel.swift` — measure request start, first-token time, total duration around `executeStream`; pass latency into `recordSendOutcome`.
4. `rings/SR-00/ModelHealthService.swift` — measure probe duration and return it; caller records it.
5. `rings/SR-00/ModelProvider.swift` — expose a small latency SLO helper (e.g. `latencyTier` / default latency threshold).
6. `BR-OUTPUT/ModelsTabView.swift` — show per-model latency badge/stat in the catalog.
7. `tests/TriOSKitTests/ModelReliabilityServiceTests.swift` — extend with latency-aware ranking tests.
8. `tests/TriOSKitTests/ModelHealthServiceTests.swift` (new) — verify probe records duration.

## PHI LOOP phases
1. **Issue** — Cycle 16 scorecard ignores latency; slow healthy models outrank fast ones.
2. **Spec** — this plan.
3. **TDD** — gates: `./build.sh`, `clade-build`, `clade-e2e`, `cargo test --workspace`, `cargo clippy --workspace`, `clade-audit` 0 findings, `clade-seal` SEAL VALID; new latency-ranking tests.
4. **Impl** — implement files 1–7 above.
5. **Gen** — not applicable.
6. **Seal** — run clade-build, clade-e2e, clade-audit, clade-seal.
7. **Verify** — relaunch `trios.app`, check `/health`, open Models tab, observe latency values after health check.
8. **Land** — commit to `dev` branch.
9. **Learn** — save experience entry and update `.trinity/experience.md`.

## Verification gates
- [ ] `./build.sh` passes
- [ ] `cargo run --bin clade-build` passes
- [ ] `cargo test --workspace` passes
- [ ] `cargo clippy --workspace` passes
- [ ] `cargo run --bin clade-audit` 0 findings
- [ ] `cargo run --bin clade-seal` SEAL VALID
- [ ] `open trios.app` relaunched and `/health` OK

## Risk mitigations
- Keep latency purely additive: existing callers that omit latency still work (default nil).
- Latency score saturates so a single slow request cannot dominate forever; EMA alpha and history limit bound influence.
- Composite score formula is simple and deterministic: `composite = reliabilityScore * latencyScore` where `latencyScore` decays as latency exceeds a chosen SLO.
- No real-time pricing or external latency API dependency; measurements come from the app's own traffic.

## Three next-loop options
1. **Cross-provider failover** — allow `fallbackModels` and predictive selection to cross `ModelProvider` boundaries when the current provider is entirely unhealthy or above latency SLO (Universal LLM client pattern).
2. **Circuit-breaker cooldowns** — replace the binary `unhealthyModels` set with per-model cooldown timers and half-open recovery probes (llm-fallback-router pattern).
3. **Latency-predicted preflight switching** — use the stored EMA latency as a preflight threshold in `ChatViewModel.runPreflightHealthCheck()` so the app switches models proactively before a slow model is even tried.
