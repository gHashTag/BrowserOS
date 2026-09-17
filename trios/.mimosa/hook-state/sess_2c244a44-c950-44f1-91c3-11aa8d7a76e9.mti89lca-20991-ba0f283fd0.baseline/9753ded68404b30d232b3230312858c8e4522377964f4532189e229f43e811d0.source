# Cycle 14 Report: Provider-Native Status Integration

## What was implemented

1. **`rings/SR-00/ProviderStatusService.swift`** — new actor that queries provider-native model catalogs:
   - OpenRouter `/api/v1/models`
   - OpenAI `/v1/models`
   - Anthropic `/v1/models`
   - Ollama `/api/tags` (already used for health, included for completeness)
   - z.ai has no public catalog and is skipped.
   - Results cached for 5 minutes, independent from health-probe cache.
   - Returns `present`, `disabled`, `missing`, or `unknown(error:)`.

2. **`rings/SR-00/ModelHealthService.swift`** — injected `(any ProviderStatusServiceProtocol)?`.
   - For non-Ollama providers, `probe()` now runs a free catalog pre-check before the paid `max_tokens:1` live probe.
   - `.disabled` and `.missing` return `.unavailable` immediately, saving API spend.
   - `.present` and `.unknown` fall through to the live probe.

3. **`rings/SR-00/ModelConfigurationStore.swift`**:
   - Owns a `ProviderStatusService` and passes it into `ModelHealthService`.
   - Added `providerStatus(for:)` and `invalidateProviderStatus()`.
   - Added `@Published var providerStatuses` (unused after simplification, remains for future use).
   - Invalidates provider status on provider/baseURL/key changes.

4. **`rings/SR-00/ModelProvider.swift`** — added `hasProviderCatalog` property.

5. **`BR-OUTPUT/ModelsTabView.swift`**:
   - Tracks provider status badges locally.
   - Refreshes badges after manual Health refresh.
   - Shows orange `disabled` or red `not in catalog` badges for models that the provider catalog rejects.

6. **`tests/TriOSKitTests/ChatFailureTests.swift`** — added XCTest coverage:
   - `testProviderStatusSkipsMissingModelProbe`
   - `testProviderStatusDisablesModelProbe`
   - `testOpenRouterCatalogParsing`
   - `testStatusInvalidationResetsProviderCache`
   - Updated `MockModelHealthService` with probe-count tracking.
   - Added `MockProviderStatusService`.

## Verification results

| Gate | Result |
|------|--------|
| `./build.sh` | ✅ passed |
| `cargo test --workspace` | ✅ 101 Rust tests passed |
| `cargo clippy --workspace` | ✅ clean |
| `clade-audit` | ✅ 8/8 checks, 0 findings |
| `clade-seal` | ✅ SEAL VALID |
| App relaunch | ✅ health endpoint `{"status":"ok","cdpConnected":true}` |
| Commit | ✅ `58ee373cd` on `dev` |

## Files changed

- `BR-OUTPUT/ModelsTabView.swift`
- `rings/SR-00/ModelConfigurationStore.swift`
- `rings/SR-00/ModelHealthService.swift`
- `rings/SR-00/ModelProvider.swift`
- `tests/TriOSKitTests/ChatFailureTests.swift`
- `rings/SR-00/ProviderStatusService.swift` (new)

## Learnings

- Provider-native signals should be cached separately from liveness probes: they are cheaper, change less often, and have different semantics (catalog presence vs runtime availability).
- Actor-isolated `invalidate()` must be declared `async` in the protocol to satisfy Swift 6 actor conformance.
- Watch for shadowing local variables with type names (`URL`); rename helper functions (`makeCatalogURL`) to avoid collisions.
- Optional `any` protocol types in Swift parameter defaults must be parenthesized: `(any ModelHealthServiceProtocol)?`.

## Three next-loop options

1. **Persistent reliability scorecard** (recommended) — store per-model success/failure/uptime metrics in `agent-memory.sqlite3` and use them to rank fallback models beyond simple static ordering.
2. **Predictive pre-selection** — on app launch and provider switch, auto-pick the cheapest healthy model from the provider catalog instead of always using the static default.
3. **Provider-wide outage banners** — poll public provider status pages (OpenAI/Anthropic/OpenRouter status JSON/RSS) and surface provider-level outage banners in the Models tab and chat.
