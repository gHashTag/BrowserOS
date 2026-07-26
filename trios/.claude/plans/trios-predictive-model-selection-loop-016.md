# Cycle 16 Plan: Predictive Model Pre-selection

## Weak spots (Cycle 15 follow-up)
1. **Static default model** — `ModelConfigurationStore.init` always picks `provider.defaultModel` / `provider.suggestedModels[0]` on launch and after provider switch, ignoring the persistent reliability scorecard we just built.
2. **No cost-aware filtering** — the previous cycle's recommended option says "highest-scored *cheap* model", but there is no cost catalog, so "cheap" is undefined.
3. **No opt-in/opt-out** — users have no UI to enable or disable predictive selection or to choose a cost tier.
4. **No selection transparency** — when a model is auto-chosen, the UI does not say why.
5. **Build-gate drift** — `clade-build` LEAN_BR_OUTPUT was missing `LogsTabView.swift`, causing a baseline failure even though `build.sh` included it.

## Competitor patterns
- **OpenRouter Auto Router** exposes a `cost_quality_tradeoff` dial (0 = pure quality, 10 = cheapest) and `allowed_models` filters. Response includes the chosen model for observability.
- **Longshot orchestrator** uses weighted random routing among healthy endpoints with EMA latency and health tracking; recovery probes every 30 seconds.
- **llm-fallback-router** combines cost-aware routing, circuit breakers, and a decision audit trail (`response.decision`).
- **Universal LLM client** maintains provider status, cooldowns, and a priority-ordered failover chain.

Common pattern: score = f(cost, latency, uptime) with user-controllable tradeoffs and visible decision reasoning.

## Goal for Cycle 16
On launch and on provider/baseURL change, automatically select the highest-reliability model within the user's chosen cost tier. Fall back to the provider default when there is no history. Make the choice transparent and overrideable.

## Files to touch
1. `rings/SR-00/ModelCostService.swift` (new) — static cost catalog and tier classification.
2. `rings/SR-00/ModelReliabilityService.swift` — add `bestModel(candidates:provider:baseURL:tier:excluding:)` and `bestReliableModel(...)` helpers.
3. `rings/SR-00/ModelConfigurationStore.swift` — add `isPredictiveSelectionEnabled` and `preferredCostTier` preferences; auto-select best model on init and provider/baseURL/key changes; expose selection reason.
4. `BR-OUTPUT/ModelsTabView.swift` — add Smart Selection section: toggle, cost-tier picker, "Pick best now" button, reason label.
5. `tests/TriOSKitTests/ModelCostServiceTests.swift` (new) — tier classification and within-tier filtering.
6. `tests/TriOSKitTests/ModelReliabilityServiceTests.swift` — add `bestModel` tests.
7. `rings/RUST-01/clade-build/src/main.rs` — already added `LogsTabView.swift` to the LEAN_BR_OUTPUT whitelist.

## PHI LOOP phases
1. **Issue** — Cycle 15 scorecard is unused for the initial model choice.
2. **Spec** — this plan is the spec.
3. **TDD** — gates: `./build.sh`, `cargo test --workspace`, `cargo clippy --workspace`, `clade-audit` 0 findings, `clade-seal` SEAL VALID; new XCTest coverage for cost service and `bestModel`.
4. **Impl** — implement files 1–6 above.
5. **Gen** — not applicable; Swift is canonical.
6. **Seal** — run clade-build, clade-e2e, clade-audit, clade-seal.
7. **Verify** — relaunch `trios.app`, check `/health`, open Models tab and exercise smart selection.
8. **Land** — commit to `feat/zai-provider` with conventional message.
9. **Learn** — save experience entry and update `.trinity/experience.md`.

## Verification gates
- [x] `./build.sh` passes
- [x] `cargo run --bin clade-build` passes
- [x] `cargo test --workspace` passes
- [x] `cargo clippy --workspace` passes
- [x] `cargo run --bin clade-audit` 0 findings
- [x] `cargo run --bin clade-seal` SEAL VALID
- [x] `open trios.app` relaunched and `/health` OK
- [x] `swift test` skipped (CommandLineTools-only environment); XCTest files compile via package target when Xcode is available

## Risk mitigations
- Keep the change additive: existing behavior is preserved when predictive selection is disabled.
- Tier filtering never eliminates all candidates; if no model matches the tier, fall back to the reliability-ranked full list.
- On first launch with no history, the provider default is used so prediction is a no-op until the scorecard has data.
- `selectModel(_:)` from the UI always overrides prediction and is persisted normally.

## Three next-loop options
1. **Latency-aware routing** — record observed request latency in `ModelOutcome` and include EMA latency in the ranking score (competitor: Longshot).
2. **Cross-provider failover** — allow the fallback chain and predictive selection to cross providers when the current provider is entirely unhealthy (competitor: Universal LLM client).
3. **Circuit-breaker cooldowns** — replace the binary `unhealthyModels` set with per-model cooldown timers and half-open recovery probes (competitor: llm-fallback-router).
