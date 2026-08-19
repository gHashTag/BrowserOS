# TriOS Cross-Provider Failover — Cycle 18 Plan

## 1. Weak-spot analysis

Cycle 17 made model ranking latency-aware, but the failover and predictive selection are still scoped to a single `ModelProvider` + `baseURL` tuple. Consequences:

1. **Provider-wide outage = total chat failure.** If the active provider returns 503/429/401 for every model (OpenRouter gateway error, Anthropic overload, expired OpenAI key, local Ollama not running), `ModelConfigurationStore.fallbackModels`, `selectNextModel()`, and `selectFirstHealthyModel()` only shuffle within the same provider. There is no escape hatch.
2. **Predictive selection is trapped.** `applyPredictiveSelection` calls `reliabilityService.bestModel` with `selectedProvider` and `selectedBaseURL`. Even when another provider is clearly healthy, the smart picker cannot choose it.
3. **Reliability histories are siloed by provider.** The same model string (e.g. `claude-sonnet-4-5`) observed via Anthropic and via OpenRouter is stored under two different keys, so a healthy history on one provider does not help ranking on the other.
4. **No eligibility gating.** The store currently assumes the active provider is the only one with credentials. A cross-provider switch must check whether the target provider has an API key (or needs none, e.g. Ollama).
5. **UI gives no provider-level signal.** `ModelsTabView` shows per-model badges inside the current provider but does not tell the user that the *entire provider* is down or that a cross-provider fallback is in effect.

## 2. Competitor / pattern research

| Product / pattern | Cross-provider behavior | Relevant design notes |
|-------------------|---------------------------|-----------------------|
| **OpenRouter** native `models` array | Provider-side ordered fallback inside OpenRouter only. | TriOS already supports this (`ModelRuntimeConfiguration.apply` emits `models` for `.openrouter`). It does not help when OpenRouter itself is the problem. |
| **LibreChat / LobeChat** provider list | User manually switches providers; no automatic failover across keys. | Manual switching is not enough for a "set and forget" Trinity agent. |
| **LiteLLM Proxy / Infinity API** | Proxy layer routes by model id across upstreams; client is unaware. | TriOS intentionally avoids a required proxy so it can run directly against each provider. |
| **Universal LLM client pattern** (Vercel AI SDK, LangChain) | Enumerate multiple providers, probe or rank, pick first healthy. | Best fit: keep provider abstraction, add client-side ranking + failover. |
| **Circuit-breaker + fallback chain** (Netflix/Hystrix style) | Per-endpoint failure streak, cooldown, half-open retry. | Future cycle candidate; Cycle 18 focuses on the first cross-provider hop. |
| **Zeph / Anyscale warmup probes** | Parallel probes pick lowest-latency provider. | Cycle 16/17 next option; can be layered on top after cross-provider enumeration exists. |

**Decision:** implement the Universal LLM client pattern inside TriOS: enumerate all configured providers, filter by credential availability, rank by the existing composite reliability × latency score, and use that ranking for both predictive selection and automatic failover.

## 3. Goal

Enable TriOS to fall back and predictively select models across `ModelProvider` boundaries when the current provider is entirely unhealthy or all of its models are unavailable, while:

- keeping per-(provider, baseURL, model) reliability histories intact;
- only switching to providers that have a usable API key (or require none);
- showing the user which provider/model is active and why;
- passing all Trinity gates and not regressing the menu-bar logo invariant.

## 4. Design decisions

### 4.1 Provider eligibility
- A provider is eligible if `requiresAPIKey == false` (Ollama) **or** `ModelCredentialStore.read(for: provider)` returns a non-empty string **or** `ModelConfigurationStore` can resolve a non-empty key from `~/.trios/config.json` / environment.
- Cross-provider ranking uses each provider's **default** base URL unless the user has previously customized that provider's base URL (persisted per provider in `UserDefaults`). We do **not** invent endpoints.
- The active provider remains the source of truth for UI state; cross-provider selection mutates `selectedProvider`, `selectedModel`, and `baseURL` through existing `selectProvider`/`selectModel`/`updateBaseURL` paths so the rest of the app (request builder, transport, health poller) needs no changes.

### 4.2 Reliability scoring across providers
- Reuse `ModelReliabilityService.compositeScore` and existing per-key histories. Do not merge histories across providers: a model that works on OpenRouter may fail on Anthropic because of prompt format or region restrictions.
- Add `rankedCrossProviderFallbacks(currentProvider:currentBaseURL:currentModel:)` that returns `[(provider: ModelProvider, baseURL: String, model: String, score: Double)]` sorted by composite score, excluding the current tuple and providers without credentials.
- Add `bestCrossProviderModel(...)` used by predictive selection when no in-provider candidate is healthy.

### 4.3 Failover sequence in ChatViewModel
1. Existing preflight: if selected model is unavailable, switch within provider (`selectFirstHealthyModel`).
2. Existing single-provider failover: if the request fails with a provider-side `TransportError`, mark original model unhealthy, try one other model within the same provider.
3. **NEW** — if the single-provider failover also fails (or no candidate exists) and `isCrossProviderFailoverEnabled` is true and the error is provider-side (model unavailable, invalid model, gateway, rate limit, auth failure implying provider-level issue), attempt `modelStore.selectFirstHealthyCrossProviderModel()` and retry once.
4. Record outcomes under the new provider/model/baseURL.
5. If cross-provider retry succeeds, leave the new provider active for the rest of the turn. If it fails, restore the original provider/model selection (like the in-provider failover already does) and surface the error.

### 4.4 UI
- Add a toggle "Allow cross-provider failover" in `ModelsTabView`.
- Add a "Probe all providers" button that runs lightweight health probes across all eligible providers and shows a per-provider reachability row.
- Show `crossProviderFailoverReason` in the active model section when the current selection was chosen automatically across providers.

### 4.5 Persistence / schema
- No new SQL schema is required; the reliability store already keys by `(provider, baseURL, model)`.
- Persist the toggle in `UserDefaults` under `trios.model.cross-provider-failover-enabled`.

## 5. Decomposed tasks

| # | Task | Files | Acceptance criteria |
|---|------|-------|---------------------|
| 1 | Extend `ModelReliabilityService` with cross-provider ranking | `rings/SR-00/ModelReliabilityService.swift` | `rankedCrossProviderFallbacks` and `bestCrossProviderModel` exist, use existing composite score, exclude ineligible providers, no change to existing single-provider API behavior. |
| 2 | Extend `ModelConfigurationStore` with cross-provider selection | `rings/SR-00/ModelConfigurationStore.swift` | `isCrossProviderFailoverEnabled`, `crossProviderConfigurations`, `selectFirstHealthyCrossProviderModel()`, `applyPredictiveSelectionCrossProvider()`, `crossProviderFailoverReason`; resolves API keys per provider; uses injected health/status services. |
| 3 | Wire cross-provider failover in send/failover path | `rings/SR-02/ChatViewModel.swift` | After in-provider failover fails, one cross-provider retry is attempted when enabled and error is provider-side; banner shown; outcomes recorded under new provider; selection restored on failure. |
| 4 | Add cross-provider UI | `BR-OUTPUT/ModelsTabView.swift` | Toggle, "Probe all providers" button, provider reachability rows, active-model reason label. |
| 5 | Add XCTest coverage | `tests/TriOSKitTests/ModelReliabilityServiceCrossProviderTests.swift`, `tests/TriOSKitTests/ModelConfigurationStoreCrossProviderTests.swift` | Cross-provider ranking order, credential gating, health-probe path, predictive selection fallback, no regression of existing tests. |
| 6 | Run Trinity gates | `build.sh`, `cargo` bins, `clade-audit`, `clade-seal`, `clade-e2e` | All gates pass; menu-bar logo relaunched; `/health` OK. |
| 7 | Save experience & memory | `.trinity/experience/`, `.claude/plans/` | Episode JSON, experience.md entry, persistent memory entry. |

## 6. Test plan

- **Unit tests (Swift)** — use in-memory `VolatileMemoryStore` reliability backend and stub health/status services to avoid Keychain and network.
  - All providers with credentials but no history return provider order as tie-breaker.
  - A provider with all models failing is ranked below a healthy provider.
  - A provider without an API key is excluded.
  - `selectFirstHealthyCrossProviderModel()` picks the highest-ranked model not in `unhealthyModels`.
  - Predictive selection falls back cross-provider when no in-provider model has history and cross-provider failover is enabled.
- **Chat integration tests** — `tests/swift/run_chat_sse_e2e.sh` should still pass; we do not exercise real cross-provider failover because the mock server only simulates one provider.
- **Trinity gates** — `build.sh`, `clade-build`, `clade-e2e`, `cargo test --workspace`, `cargo clippy --workspace`, `clade-audit`, `clade-seal`.

## 7. Gate checklist

- [ ] `./build.sh` passes (chat integration tests pass or are skipped appropriately).
- [ ] `cargo run --bin clade-build` passes.
- [ ] `cargo run --bin clade-e2e` passes.
- [ ] `cargo test --workspace` passes.
- [ ] `cargo clippy --workspace` passes.
- [ ] `cargo run --bin clade-audit` hard gates = 0 findings.
- [ ] `cargo run --bin clade-seal` reports `SEAL VALID`.
- [ ] `open trios.app` relaunched and `curl -s http://127.0.0.1:9105/health` returns `{"status":"ok",...}`.
- [ ] No new `*.sh` on the critical path (L7 UNITY).

## 8. Risks and rollback

- **Risk:** Cross-provider switch accidentally changes the provider for subsequent turns. **Mitigation:** Restore original provider/model on cross-provider retry failure; leave it active only on success.
- **Risk:** API key probing triggers repeated Keychain prompts. **Mitigation:** Use existing `ModelCredentialStore.read` which is silent for already-allowed items; do not prompt the user during automatic failover.
- **Risk:** Background health poller only probes the active provider. **Mitigation:** Cross-provider failover relies on send-time health probes and stored reliability, not background polling of every provider. The "Probe all providers" button is manual.
- **Rollback:** Remove the `isCrossProviderFailoverEnabled` toggle default and the new ChatViewModel branch; existing single-provider behavior remains untouched.

## 9. Expected outcome

TriOS can escape a completely unhealthy provider by automatically switching to another configured provider, ranked by learned reliability and latency, with full UI transparency. All Trinity gates remain green and the menu-bar logo stays alive.

## 10. Next-loop options (to be finalized in the Cycle 18 report)

1. **Adaptive parallel probes / lowest-latency routing** — issue tiny warmup probes to multiple providers in parallel and pick the winner per request (Zeph/Anyscale pattern).
2. **Circuit-breaker cooldowns + half-open recovery** — replace the binary `unhealthyModels` set with per-model cooldown timers and automatic half-open retry.
3. **Provider-agnostic model aliases** — map logical aliases (`best-cheap-coding`, `best-reasoning`) to concrete provider/model tuples and let the scorecard route to the best instance.
