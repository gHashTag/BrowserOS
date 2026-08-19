# Cycle 30 — Adaptive Watchdog Thresholds

## Weak spots investigated
- **Static context/output ceilings**: `ModelContextService` used only advertised `maxContextTokens` / `maxOutputTokens` from a static catalog. The same model slug on a different endpoint (custom OpenRouter proxy, self-hosted Ollama, enterprise Anthropic base URL) can have materially smaller effective limits, so the watchdog warned/paused at the wrong ratio.
- **No feedback from actual terminations**: `finish_reason=length`, context-length pauses, and provider 413/400 errors were not recorded as evidence about the real limit. The system repeated the same mistake every turn.
- **Output-limit default action**: when the assistant hit an output-token ceiling, the default suggestion was `stopHere`, discarding a useful partial response.
- **BaseURL blindness**: context-window utilization badges and routing decisions ignored `baseURL`, collapsing per-endpoint behavior into a single per-provider/profile view.

## Competitor / topic research
- **OpenRouter `finish_reason`**: downstream SDKs expose the terminal SSE `finish_reason`; many routers rewrite it as `"length"` even when the upstream did not.
- **Zephyr / Anyscale adaptive routing**: per-endpoint probes learn TTFT and context headroom; we reused the same tuple-key idea but for *limit* learning instead of latency.
- **OpenAI `usage` block**: total + completion tokens arrive in a final `usage` event; our learner blends that with the watchdog's own estimate when `usage` is missing.
- **Universal LLM clients (Continue, Lovable)**: surface learned or user-reported context windows in the model picker. We added per-tuple learned badges in `ModelsTabView`.

## Decomposed plan
1. Extend the `model_outcomes` schema (v4→v5) to store `observed_output_tokens`, `observed_total_tokens`, and `finish_reason`.
2. Update `SSEEvent.finish` and the parser to carry `finish_reason` through the transport.
3. Add `StreamingContextLimitLearner` that records `ModelOutcome` observations per `(provider, baseURL, model)`, maintains EMA-based learned output/total limits, and only overrides advertised limits after at least 3 observations and a 0.95 safety buffer.
4. Make `ModelContextService.profile(for:provider:baseURL:)` async and blend advertised catalog data with learned limits; thread `baseURL` through `largerContextCandidates` / `largerModelCandidates`.
5. Update `ModelConfigurationStore` to inject the learner, forward observed tokens/finish reason to the learner, and expose `learnedLimits(for:provider:baseURL:)` plus a `baseURL`-aware utilization percent.
6. Update `ChatViewModel` to capture observed output/total tokens and `finish_reason` from `.finish` / `.usage` events, populate pause-time estimates via `contextWatchdog.estimatedTokens()`, and pass them through `recordSendOutcome`.
7. Change `StreamingContextWatchdog.defaultSuggestedAction` so `.outputTokens` recommends `continueOnLargerModel` by default.
8. Update `ModelsTabView` to fetch and display learned output/context badges next to advertised limits.
9. Add/extend tests: SSE parser finish reason, learner EMA tightening, output-limit default action, observed-token persistence, and `ModelContextServiceTests` baseURL updates.
10. Run `./build.sh`, `cargo test`, `cargo clippy`, `clade-audit`, `clade-seal`, `clade-e2e`, relaunch `trios.app`, and capture the closure report + three Cycle-31 options.

## Implementation summary
- `.trinity/specs/streaming-context-watchdog.md`: added INV-12 through INV-16 documenting per-tuple learning, EMA parameters (`alpha=0.3`, `minObservations=3`, `safetyBuffer=0.95`), output-limit default action, and UI visibility.
- `rings/SR-00/ModelReliabilityService.swift`: extended `ModelOutcome` with `observedOutputTokens`, `observedTotalTokens`, `finishReason`; added `record(outcome:)` helper.
- `rings/SR-01/MemoryStore.swift`: bumped `schemaVersionNumber` to 5; added new columns via `ALTER TABLE`; updated `saveOutcome`/`outcomes`/`decodeOutcome` round-trips.
- `rings/SR-01/ChatEvents.swift`: `SSEEvent.finish(id: String)` → `SSEEvent.finish(id: String, reason: String?)`; parser extracts `finish_reason`.
- `rings/SR-00/StreamingContextLimitLearner.swift`: new actor with `recordOutcome(_:)`, `learnedProfile(for:provider:baseURL:advertised:)`, and `learnedLimits(for:provider:baseURL:)`.
- `rings/SR-00/ModelContextService.swift`: async `profile(for:provider:baseURL:)`, `advertisedProfile(for:provider:)`, `largerContextCandidates`/`largerModelCandidates` baseURL-aware.
- `rings/SR-00/ModelConfigurationStore.swift`: learner injection, `recordSendOutcome` overloads forwarding observed tokens/finish reason, `learnedLimits(for:provider:baseURL:)`, baseURL-aware utilization.
- `rings/SR-02/ChatViewModel.swift`: `StreamLatency` extended; `executeStream` tracks `streamFinishReason`, `observedOutputTokens`, `observedTotalTokens`; pause path calls `contextWatchdog.estimatedTokens()`; all `recordSendOutcome` / `profile` / `contextWindowUtilizationPercent` calls pass `activeBaseURL`.
- `rings/SR-00/StreamingContextWatchdog.swift`: added `estimatedTokens() -> (input: Int, output: Int)`; `.outputTokens` default action is `.continueOnLargerModel`.
- `BR-OUTPUT/ModelsTabView.swift`: `@State private var learnedLimitBadges`, `refreshContextUtilizationBadges()` fetches learned limits, catalog rows display learned output/context badges when available.
- Tests: `tests/TriOSKitTests/SSEEventParserTests.swift`, `StreamingContextWatchdogTests.swift`, new `StreamingContextLimitLearnerTests.swift`, `ModelReliabilityServiceTests.swift`, and `ModelContextServiceTests.swift` updated for baseURL.

## Validation
- `./build.sh` PASS (with `TRIOS_SKIP_CHAT_E2E=1`; XCTest unavailable in CommandLineTools-only environment).
- `cargo test -p trios-mesh` PASS (101 tests).
- `cargo clippy -p trios-mesh -- -D warnings` PASS.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-audit`: hard gates **0 findings** across all 8 checks.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-seal`: **SEAL VALID**.
- `TRIOS_SKIP_CHAT_E2E=1 cargo run --bin clade-e2e`: PASS, app PID healthy, screenshot captured.
- `open trios.app` relaunched after build; menu-bar logo present; `clade-e2e` confirmed TriOS App PID alive.

## Cycle-31 options
1. **Learned-limit-driven request sizing and routing** — feed `StreamingContextLimitLearner` profiles into `ChatRequestSizer` and `resolveContextRoutingDecision` so TriOS routes to a larger model or trims history *before* the observed ceiling is hit, not only before the advertised one.
2. **Streaming token budget UI** — render a live output/context budget progress bar in the composer that uses advertised + learned limits, with color bands for safe / warning / pause and a per-send max-output-token cap.
3. **Per-conversation provider/model pinning** — let the user pin a provider/model/baseURL per chat thread so adaptive warmup, context routing, and cross-provider failover operate only within the allowed boundary.

φ² + 1/φ² = 3 | TRINITY
