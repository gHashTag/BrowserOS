# Cycle 14: Provider-Native Status Integration

## 1. Weak spots of Cycle 13 (background health poller)

| Weak spot | Impact | How provider-native status fixes it |
|---|---|---|
| Burns paid probes for every model | Each cloud probe is a `max_tokens:1` completion; cost scales with model count | Free provider catalog endpoints are queried first; live probe only when catalog says the model exists |
| No provider-wide outage detection | Probes models one by one during an outage | Provider catalog fetch failure marks all models unknown/unavailable in one shot |
| Cannot distinguish "removed" vs "down" | A 404 probe could mean either | Provider catalog absence means the model is disabled/removed; live probe failure means temporary down |
| No provider-level metadata | Pricing, context length, and enabled flags are ignored | OpenRouter `/api/v1/models` exposes `enabled` and per-model flags we can surface |
| Wastes time probing stale models | Old fallback models may no longer exist | Catalog check filters the fallback chain before it is used |

## 2. Competitor / reference research

- **OpenRouter `/api/v1/models`** — free, unauthenticated endpoint returning every model with `id`, `name`, `pricing`, `context_length`, and `enabled` boolean. The canonical source of truth for what OpenRouter can route.
- **OpenAI `/v1/models`** — returns available model IDs; requires API key; useful for validating that a model ID is still supported.
- **Anthropic `/v1/models`** — returns Anthropic model list; requires API key.
- **Ollama `/api/tags`** — already used for both catalog and health; free and local.
- **zai provider** — does not expose a public model list; we continue to use suggested models.
- **Provider status pages** (status.openai.com, status.anthropic.com, status.openrouter.ai) — human RSS/JSON; out of scope for this cycle because model-level catalog checks are more actionable.

**Differentiation:** trios layers a fast, free catalog check in front of the paid live probe, and uses the catalog to filter fallback chains and badge removed models.

## 3. Decomposed plan

### Phase 1 — Issue / spec
- Add `ProviderStatusService` actor that fetches native provider model lists.
- Cache catalog results with a separate TTL from health probes.
- Integrate catalog presence into `ModelHealthService.probe` as a fast pre-check.

### Phase 2 — TDD
- Add tests for `ProviderStatusService` parsing OpenRouter, OpenAI, Anthropic, and Ollama responses.
- Add tests for `ModelHealthService` skipping live probe when catalog says model is missing.
- Add UI test stub for "disabled" badges (compile-only in this toolchain).

### Phase 3 — Code
1. Create `rings/SR-00/ProviderStatusService.swift`.
2. Extend `ModelHealthService` to consult `ProviderStatusService` before the paid probe.
3. Extend `ModelConfigurationStore` to expose `providerStatus(for:)` and `refreshProviderStatus()`.
4. Update `BackgroundHealthPoller` to refresh provider status before health probes.
5. Update `ModelsTabView` to show `disabled` / `removed` badges from provider status.
6. Filter fallback chain to models present in the provider catalog.

### Phase 4 — Seal
- `./build.sh` must pass.
- `cargo test --workspace` must pass.
- `cargo clippy --workspace --all-targets --all-features -- -D warnings` must pass.
- `clade-audit` and `clade-seal` must pass.
- Relaunch `trios.app`.

### Phase 5 — Learn
- Capture that provider-native signals should be fetched and cached separately from liveness probes because they are cheaper and have different semantics.

## 4. Verification gates

- [ ] Build gate: `./build.sh` 0 errors.
- [ ] Rust gate: `cargo test --workspace` all pass.
- [ ] Clippy gate: 0 warnings.
- [ ] Audit gate: `clade-audit` 0 hard findings.
- [ ] Seal gate: `clade-seal` reports `SEAL VALID`.
- [ ] UI gate: Models tab shows disabled/removed badges where applicable.
- [ ] Manual gate: Provider status refresh happens before manual Health refresh.

## 5. Three next-loop options

1. **Persistent reliability scorecard** (recommended) — store per-model success/failure history in `agent-memory.sqlite3` and rank models by uptime score.
2. **Predictive pre-selection** — use health + provider status to auto-select the cheapest healthy model at launch / provider switch.
3. **Provider status page integration** — poll public status pages (RSS/JSON) for provider-wide outage banners and show them in the Models tab and chat banners.
