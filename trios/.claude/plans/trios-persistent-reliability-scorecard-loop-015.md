# Cycle 15: Persistent Reliability Scorecard

## 1. Weak spots of Cycle 14 (provider-native status integration)

| Weak spot | Impact | How persistent scorecard fixes it |
|---|---|---|
| Catalog presence is static and temporary | A model can be present in the catalog but repeatedly fail at runtime; we have no memory of that | Store every probe/send outcome with timestamp and compute an uptime score |
| Fallback order is hard-coded | `fallbackModels()` uses the provider's static suggestion list, not observed reliability | Rank fallbacks by recent uptime score instead of static order |
| Recovery detection is binary | A model flips in/out of `unhealthyModels` based on the latest probe | Exponential moving average smooths transient blips and prevents flapping |
| No cost-aware ranking | Expensive models may be preferred even when cheaper models are equally reliable | Scorecard can combine uptime + cost/pricing metadata in future cycles |
| Manual Health button is still required for badges | Badges only update after explicit refresh | Background poller records outcomes automatically and updates scores |
| One failover then stop | After one failover the app may stick with a poor fallback | Scorecard lets preflight pick the best model globally before any request |

## 2. Competitor / reference research

- **OpenRouter `/api/v1/models`** exposes `pricing` per model (prompt/completion per token) and `context_length`. We can consume this in the same `ProviderStatusService` fetch and store it alongside reliability.
- **Kubernetes pod readiness / load balancers** use configurable failure thresholds and success thresholds to avoid flapping; we mirror this with exponential moving average (EMA) smoothing.
- **LLM routing proxies (LiteLLM, OpenRouter)** maintain per-model success-rate metrics and route to the cheapest available model; trios can do this client-side without an extra proxy.
- **Observability tools** keep time-series of error rates; we keep a bounded event log (last N outcomes per model) to bound database growth.
- **ChatGPT/Claude apps** do not expose per-model reliability to users; trios differentiates by showing a score and ranking models by observed uptime.

## 3. Decomposed plan

### Phase 1 — Spec
- Add `ModelReliabilityService` actor with persistence through `AgentMemoryStoreProtocol`.
- Store per-model outcomes: `success`, `failure(reason:)`, `timestamp`.
- Compute EMA uptime score over the last N outcomes (default 20) with decay.
- Expose ranked fallback models combining provider preference + score.

### Phase 2 — TDD
- Tests for EMA score calculation.
- Tests for persistence round-trip via `VolatileMemoryStore`.
- Tests for fallback ranking when scores differ.
- Tests that preflight picks the highest-scored healthy model.

### Phase 3 — Code
1. Create `rings/SR-00/ModelReliabilityService.swift`:
   - `ModelOutcome` struct: model, provider, baseURL, success, reason, timestamp.
   - `ModelReliability` struct: score (0...1), total probes, recent failures.
   - `record(outcome:)` persists to a new `model_outcomes` table or memory-store record.
   - `reliability(for:)` returns EMA score.
   - `rankedFallbacks(excluding:from:)` returns models sorted by score, then provider order.
2. Extend `MemoryStore` schema to v3 with `model_outcomes` table.
3. Extend `AgentMemoryStoreProtocol` with `saveOutcome`, `outcomesForModel`, `deleteOutcomes`.
4. Wire `ModelReliabilityService` into `ModelConfigurationStore`:
   - Record health-probe outcomes in `refreshHealth()`.
   - Record send success/failure in `ChatViewModel` preflight/failover paths.
   - Use ranked fallback order in `fallbackModels`.
5. Update `ModelsTabView` to show a small reliability percentage next to each model.
6. Update `BackgroundHealthPoller` to record probe outcomes into the scorecard.

### Phase 4 — Seal
- `./build.sh` 0 errors.
- `cargo test --workspace` all pass.
- `cargo clippy --workspace` clean.
- `clade-audit` and `clade-seal` pass.
- Relaunch `trios.app`.

### Phase 5 — Learn
- Capture that per-model reliability should be persisted with bounded history and EMA smoothing to avoid flapping.

## 4. Verification gates

- [x] Build gate passes (swift test skipped: XCTest unavailable in Command Line Tools).
- [x] Rust gate passes.
- [x] Clippy gate clean.
- [x] Audit gate 0 findings.
- [x] Seal gate `SEAL VALID`.
- [x] App relaunch healthy.
- [x] New tests exercise EMA, persistence, and ranking.

## 5. Three next-loop options

1. **Predictive pre-selection** (recommended) — on app launch / provider switch, automatically select the highest-scored cheap model instead of the static default.
2. **Pricing-aware routing** — store per-token pricing from OpenRouter catalog and rank by `score / cost` so trios prefer cheap, reliable models.
3. **Provider-wide outage banners** — poll public status pages and show provider-level outage banners, while the scorecard handles model-level failures.
