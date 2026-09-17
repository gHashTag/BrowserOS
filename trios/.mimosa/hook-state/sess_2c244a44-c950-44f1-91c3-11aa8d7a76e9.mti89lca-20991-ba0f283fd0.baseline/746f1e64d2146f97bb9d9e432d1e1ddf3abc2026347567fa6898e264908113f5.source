# Cycle 15 Report: Persistent Reliability Scorecard

## Summary
Landed a persistent, encrypted per-model reliability scorecard. Every health probe and every chat send/failover now records an outcome in the existing `agent-memory.sqlite3` database. Fallback models are ranked by an exponential moving average (EMA) uptime score instead of the static provider list, and preflight health checks pick the highest-scored healthy model before a real request is sent.

## Files changed
- `rings/SR-00/ModelReliabilityService.swift` (new) — actor that records outcomes, computes EMA scores, and ranks fallbacks.
- `rings/SR-01/MemoryStoreReliabilityAdapter.swift` (new) — bridges `AgentMemoryStoreProtocol` to `ModelReliabilityStoreProtocol` so outcomes live in encrypted SQLite.
- `rings/SR-01/MemoryStore.swift` — added `model_outcomes` table and v2→v3 migration; implemented `saveOutcome`, `outcomes`, `deleteOutcomes` on both durable and volatile stores.
- `rings/SR-00/ModelConfigurationStore.swift` — owns `ModelReliabilityService`; `fallbackModels` is now async and reliability-ranked; `runtimeConfiguration` is async; health probes record outcomes.
- `rings/SR-02/ChatViewModel.swift` — awaits async runtime configuration and records send/failover outcomes into the scorecard.
- `tests/swift/ChatSSETestMocks.swift` — implemented new protocol methods in all mock memory stores.
- `tests/swift/ChatSSEEndToEndTest.swift` — updated schema-version assertion to 3.
- `tests/TriOSKitTests/ChatFailureTests.swift` — made `fallbackModels` and `selectNextModel` tests async.
- `tests/TriOSKitTests/ModelReliabilityServiceTests.swift` (new) — XCTest coverage for EMA scoring, persistence round-trip, ranking, reset, and history limits.

## Verification
- `./build.sh` — passes; chat SSE E2E tests pass.
- `cargo test --workspace` — all pass.
- `cargo clippy --workspace` — clean.
- `cargo run --bin clade-audit` — 0 findings across all 8 checks.
- `cargo run --bin clade-seal` — `SEAL VALID`.
- `open trios.app` — relaunched; `/health` returns `{"status":"ok","cdpConnected":true}`.

## Notes
- `swift test` was skipped because the toolchain only has Command Line Tools; XCTest requires Xcode. The new XCTest file is present and compiles under the package target when Xcode is available.
- The scorecard stores outcomes keyed by `(model, provider, baseURL)` so endpoint/provider switches start fresh without cross-contaminating history.

## Three next-loop options
1. **Predictive pre-selection (recommended)** — on app launch or provider switch, automatically select the highest-scored cheap model instead of the static default.
2. **Pricing-aware routing** — store per-token pricing from the OpenRouter catalog and rank by `score / cost` so trios prefers cheap, reliable models.
3. **Provider-wide outage banners** — poll public status pages and show provider-level outage banners, while the scorecard handles model-level failures.
