# Cycle 21 Report — Budget / Quota-Aware Adaptive Warmup Gating

**Date:** 2026-07-26  
**Branch:** `feat/zai-provider`  
**Selected variant:** A (Budget/quota-aware adaptive warmup gating) from Cycle 20 options  
**Road:** B — fix + test + experience save

---

## 1. What was researched

### Weak spots in Cycle 20
1. **HTTP 402 Insufficient Balance was swallowed.** `ModelHealthService.probeCloud` returned `.unknown(error: "Insufficient balance — not a model problem")` for HTTP 402. The warmup service then recorded it as `ProviderCircuitBreakerFailureKind.unknown`, so a provider with depleted credits was not treated as economically unavailable and could still be selected.
2. **Quota headers were ignored.** Successful probes from OpenRouter/OpenAI return `x-ratelimit-remaining-requests` / `x-ratelimit-remaining-tokens`. TriOS did not capture these, so a provider about to be throttled could win the warmup race.
3. **Warmup scoring was latency-only.** `ModelWarmupService.scoreCandidates` used reliability × latency. A provider with depleted credits but fast latency still scored high because balance was not a scoring input.
4. **No per-endpoint quota tracking.** There was no actor or store that remembered the latest quota/balance snapshot for a `(provider, baseURL)` endpoint.
5. **UI lacked economic signals.** `ModelsTabView` showed circuit-breaker state but not balance/quota status, so users could not see *why* a provider was skipped.
6. **Breaker `.balance` cooldown was not distinct.** The breaker already had a `.balance` failure kind but applied the same cooldown logic as `.auth`; both should be longer/more visible than transient errors.

### Competitor patterns
- **OpenRouter** returns `x-ratelimit-remaining-tokens` and `x-ratelimit-remaining-requests` on every streaming/non-streaming response. Many multi-provider clients read these headers to route away from keys near exhaustion.
- **LiteLLM** supports per-key `budget` and `rpm/tpm` limits, and its router falls back when a key exceeds its configured spend or rate.
- **Portkey** "Guardrails" include spend controls and rate-limit awareness at the gateway layer.
- **Anyscale / Zeph-style** routers deprioritize providers whose quota is below a safety margin even when the endpoint is technically healthy.

TriOS adopted a lightweight, header-based approach: parse standard rate-limit headers on probes, track balance/depletion signals, and feed them into warmup scoring.

---

## 2. What was implemented

### Data model
- Added `ProviderQuotaStatus` enum: `.unknown`, `.healthy(remainingRequests: Int?, remainingTokens: Int?)`, `.low(remainingRequests: Int?, remainingTokens: Int?)`, `.depleted(reason: String)`. All conformances `Equatable`, `Sendable`.
- Extended `ModelHealthResult` with `quota: ProviderQuotaStatus`.

### Health probe quota capture
- `ModelHealthService.probeCloud` now parses `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`, `x-ratelimit-limit-requests` (plus OpenAI-style fallbacks).
- HTTP 402 → `.unavailable(reason: "Insufficient balance (402)")` health + `.depleted(reason: "Insufficient balance")` quota.
- HTTP 429 → `.unavailable` health + parsed quota (so rate-limit still feeds scoring).
- Low-quota classification: remaining ≤ 5, or remaining ≤ 10% of limit.

### Quota snapshot service
- New `ProviderQuotaService` actor keyed by `ProviderEndpointKey`.
- `record(provider:baseURL:quota:)` and `status(for:baseURL:)` APIs.
- `invalidate()` clears snapshots on endpoint/key change.
- Injected into `ModelConfigurationStore` and `ModelWarmupService`.

### Quota-aware warmup scoring
- `ModelWarmupService.scoreCandidates` reads the latest quota status per endpoint.
- Multipliers: `.depleted` → 0, `.low` → 0.5, `.unknown` → 0.9, `.healthy` → 1.0.
- Added `strictQuotaGating: Bool` parameter; when true, `.depleted` candidates are excluded unless they are the current selection.

### Circuit breaker balance handling
- `ProviderCircuitBreaker.computeCooldown` now applies a floor of `baseCooldown * 4` for `.balance` failures, making top-up issues clearly slower to recover than transient errors.
- `ModelHealth.circuitBreakerFailureKind` maps "insufficient balance" / 402 to `.balance`.

### Store wiring and toggle
- `ModelConfigurationStore` exposes `@Published isStrictQuotaGatingEnabled`, persisted via `UserDefaults` under `trios.model.strict-quota-gating-enabled`.
- Added `quotaStatus(for provider:baseURL:)` helper and wired `quotaService.invalidate()` into `invalidateHealth()`.
- Passes `strictQuotaGating: isStrictQuotaGatingEnabled` to `ModelWarmupService.warmup`.

### UI badges
- Added a "Strict quota gating" toggle under the adaptive warmup section in `ModelsTabView`.
- Added per-provider quota badges (green/orange/red) in the warmup section, refreshed when the tab appears, when the provider changes, and after each warmup run.

### Tests
- `ModelHealthServiceTests` — healthy headers, low headers, depleted header, 402 mapping, 429 with quota.
- `ProviderQuotaServiceTests` (new) — round-trip, endpoint isolation, invalidate.
- `ModelWarmupServiceTests` — strict gating excludes depleted candidate; low quota deprioritizes candidate.
- `ProviderCircuitBreakerTests` — balance cooldown floor is 4× base.

---

## 3. Files changed

- `trios/rings/SR-00/ModelHealthService.swift`
- `trios/rings/SR-00/ProviderQuotaService.swift` (new)
- `trios/rings/SR-00/ModelWarmupService.swift`
- `trios/rings/SR-00/ProviderCircuitBreaker.swift`
- `trios/rings/SR-00/ModelConfigurationStore.swift`
- `trios/BR-OUTPUT/ModelsTabView.swift`
- `trios/tests/TriOSKitTests/ModelHealthServiceTests.swift`
- `trios/tests/TriOSKitTests/ProviderQuotaServiceTests.swift` (new)
- `trios/tests/TriOSKitTests/ModelWarmupServiceTests.swift`
- `trios/tests/TriOSKitTests/ProviderCircuitBreakerTests.swift`
- `trios/.claude/plans/trios-cycle21-budget-quota-warmup-loop-021.md`
- `trios/.claude/plans/trios-cycle21-budget-quota-warmup-loop-021-report.md`
- `trios/.trinity/experience/2026-07-26_budget-quota-warmup-loop-021.json`
- `trios/.trinity/experience.md`

---

## 4. Validation

| Gate | Result |
|------|--------|
| `bash build.sh` | PASS (chat integration tests PASS) |
| `cargo test --workspace` | PASS |
| `cargo clippy --workspace` | PASS |
| `cargo run --bin clade-audit` | 0 findings |
| `cargo run --bin clade-seal` | SEAL VALID |
| `cargo run --bin clade-e2e` | PASS |
| `open trios.app` | Relaunched; `curl http://127.0.0.1:9105/health` returns `{"status":"ok","cdpConnected":true}` |

`swift test` is unavailable in the current CommandLineTools-only environment, so the new XCTest files compile against the source but were not executed here. They will run when Xcode is installed.

---

## 5. Three next-loop options

### Option A — Predictive background warmup scheduling
Run adaptive warmup proactively every 30-60s in a background task and cache the winning `(provider, baseURL, model)` tuple. When the user sends a message, the chat path reuses the cached winner (if still fresh and healthy) instead of racing probes on the critical send path. This removes TTFT variance caused by warmup and makes the Models tab status nearly real-time.

**Fit:** Extends Cycle 20/21 infrastructure directly; small, high-value UX win.  
**Risk:** Extra API spend from background probes; needs a stale-cache policy and offline/battery awareness.

### Option B — User-defined provider preference order
Add drag-to-rank reordering of providers in `ModelsTabView` and persist the order in `UserDefaults`. Blend the explicit priority into `ModelWarmupService` scoring as a tie-breaker / mild bias so a user’s preferred provider wins when candidates are otherwise close. Also affects cross-provider failover ordering.

**Fit:** Gives users agency over routing without requiring them to understand reliability scores.  
**Risk:** UI complexity in a SwiftUI list; needs to avoid overriding strong negative signals (open breaker, depleted quota).

### Option C — Real-time spend dashboard
Capture `usage` blocks from chat completions and sum estimated per-provider spend in a lightweight in-memory ledger. Show a running balance / cost estimate badge per provider in `ModelsTabView`, and optionally gate providers when a user-defined daily/monthly budget is exceeded.

**Fit:** Builds on the quota service and economic signals introduced in Cycle 21; closes the loop from "how much is left" to "how much did I spend".  
**Risk:** Cost estimation is provider-specific and fragile; needs careful handling of cached/partial/streaming usage headers.

---

## 6. Notes and follow-ups

- Strict quota gating is **off by default**, preserving existing behavior. Users can opt in via the Models tab.
- Quota snapshots are **in-memory only**; they refresh on every warmup run. Persistence could be layered later if we want cross-session budget history.
- The `.balance` breaker cooldown floor is now 4× base (120s with the default 30s base), making top-up issues visually distinct from transient gateway errors.
- Next cycle should probably pick **Option A** if the goal is lower send-path latency, or **Option C** if the goal is deeper economic visibility.
